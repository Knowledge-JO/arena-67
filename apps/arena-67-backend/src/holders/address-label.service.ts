import { Inject, Injectable, Logger } from '@nestjs/common';
import { inArray, sql } from 'drizzle-orm';
import { concat, getAddress, pad, parseAbi, type Address, type Hex } from 'viem';
import { DRIZZLE } from '../database/database.constants';
import { dbOf, type Database } from '../database/database.module';
import { addressLabels } from '../database/schema';
import { ChainService } from '../chain/chain.service';
import { ZERO_ADDRESS } from './transfer-fold';

export type HolderLabel = 'wallet' | 'pool' | 'burn' | 'token' | 'contract';

export interface LabelInfo {
  label: HolderLabel;
  /** A plain-words description for the few addresses we can name. */
  name: string | null;
}

const PAIR_ABI = parseAbi([
  'function token0() view returns (address)',
  'function token1() view returns (address)',
]);

const BURN_ADDRESSES = new Set([
  ZERO_ADDRESS,
  '0x000000000000000000000000000000000000dead',
  '0xdead000000000000000042069420694206942069',
]);

/** EIP-7702: an EOA that delegates to code is still a person's wallet. */
const DELEGATION_PREFIX = '0xef0100';
const WALLET_RECHECK_MS = 24 * 3_600_000;

/**
 * Creation code for a read-only probe, run through a deployless eth_call.
 * For each 32-byte word of calldata (an address) it returns two words:
 * EXTCODESIZE, then the first 32 bytes of code (EXTCODECOPY).
 *
 *   constructor: 602d 80 600b 6000 39 6000 f3        — return the 45-byte runtime
 *   runtime:     i=0; while i < calldatasize:
 *                  a = calldataload(i)
 *                  mstore(2i, extcodesize(a)); extcodecopy(a, 2i+32, 0, 32)
 *                  i += 32
 *                return(0, 2*calldatasize)
 */
const CODE_PROBE = ('0x602d80600b6000396000f3' +
  '60005b80361115602557803580' +
  '3b8280015260206000838001602001833c50602001600256' +
  '5b503680016000f3') as Hex;
const CODE_PROBE_BATCH = 300;

/**
 * Says what kind of thing a holder is, so analysis can leave out the ones
 * that are not people.
 *
 * On this chain it is not optional. Uniswap v4 holds every pool's liquidity in
 * one contract, so an unlabelled "top holders" list starts with the
 * PoolManager for every token, and "who holds more than one of these" is the
 * PoolManager every time.
 */
@Injectable()
export class AddressLabelService {
  private readonly log = new Logger(AddressLabelService.name);
  private readonly db: Database;
  private readonly known: Map<string, LabelInfo>;

  constructor(
    @Inject(DRIZZLE) handle: unknown,
    private readonly chain: ChainService,
  ) {
    this.db = dbOf(handle);
    const v4 = chain.network.uniswapV4;
    this.known = new Map<string, LabelInfo>([
      [v4.POOL_MANAGER.toLowerCase(), { label: 'pool', name: 'Uniswap v4 liquidity' }],
      [v4.POSITION_MANAGER.toLowerCase(), { label: 'contract', name: 'Uniswap v4 positions' }],
      [v4.UNIVERSAL_ROUTER.toLowerCase(), { label: 'contract', name: 'Uniswap router' }],
      [v4.PERMIT2.toLowerCase(), { label: 'contract', name: 'Permit2' }],
      ...[...BURN_ADDRESSES].map(
        (a) => [a, { label: 'burn', name: 'Burn address' }] as [string, LabelInfo],
      ),
    ]);
  }

  /**
   * Labels a set of addresses. `token` is the token being analysed, so its
   * own contract (which often holds undistributed supply) is named as such.
   *
   * Never throws. An address whose code cannot be read comes back as
   * `contract` — the cautious answer, since it keeps it out of "wallets" —
   * and is not cached, so the next call tries again.
   */
  async label(addresses: string[], token?: string): Promise<Map<string, LabelInfo>> {
    const out = new Map<string, LabelInfo>();
    const want = [...new Set(addresses.map((a) => a.toLowerCase()))];
    const self = token?.toLowerCase();

    const unknown: string[] = [];
    for (const a of want) {
      if (a === self) out.set(a, { label: 'token', name: 'The token contract itself' });
      else if (this.known.has(a)) out.set(a, this.known.get(a)!);
      else unknown.push(a);
    }
    if (unknown.length === 0) return out;

    const cached = await this.db
      .select()
      .from(addressLabels)
      .where(inArray(addressLabels.address, unknown));
    const fresh = new Set<string>();
    for (const row of cached) {
      const stale =
        row.label === 'wallet' && Date.now() - row.checkedAt.getTime() > WALLET_RECHECK_MS;
      if (stale) continue;
      out.set(row.address, { label: row.label as HolderLabel, name: row.name });
      fresh.add(row.address);
    }

    const todo = unknown.filter((a) => !fresh.has(a));
    if (todo.length === 0) return out;

    const resolved = await this.inspect(todo);
    const rows = [...resolved.entries()]
      .filter(([, v]) => v.cacheable)
      .map(([address, v]) => ({ address, label: v.label, name: v.name }));
    for (const [a, v] of resolved) out.set(a, { label: v.label, name: v.name });

    if (rows.length) {
      await this.db
        .insert(addressLabels)
        .values(rows)
        .onConflictDoUpdate({
          target: addressLabels.address,
          set: {
            label: sql.raw('excluded."label"'),
            name: sql.raw('excluded."name"'),
            checkedAt: sql`now()`,
          },
        })
        .catch((e: Error) => this.log.warn(`label cache write failed: ${e.message}`));
    }
    return out;
  }

  /**
   * The first bytes of code at many addresses, in one `eth_call` per 300.
   *
   * There is no multicall for code, and per-address `eth_getCode` does not
   * survive this RPC's rate limit: it counts each entry of a JSON-RPC batch,
   * shares the budget with the indexer's log queries, and a hundred holders
   * came back 429 to most of them. So this runs a 45-byte program without
   * deploying it — for each address it returns EXTCODESIZE and the first 32
   * bytes of code — and a token's top 300 holders cost one round trip.
   *
   * Missing from the result means the call failed and we do not know.
   */
  private async codes(addresses: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (let i = 0; i < addresses.length; i += CODE_PROBE_BATCH) {
      const batch = addresses.slice(i, i + CODE_PROBE_BATCH);
      try {
        const { data } = await this.chain.client.call({
          code: CODE_PROBE,
          data: concat(batch.map((a) => pad(a as Hex, { size: 32 }))),
        });
        if (!data) continue;
        batch.forEach((a, n) => {
          const at = 2 + n * 128;
          const size = BigInt(`0x${data.slice(at, at + 64) || '0'}`);
          out.set(a, size === 0n ? '0x' : `0x${data.slice(at + 64, at + 128)}`);
        });
      } catch (err) {
        this.log.warn(`code probe failed for ${batch.length} addresses: ${(err as Error).message.split('\n')[0]}`);
      }
    }
    return out;
  }

  /** Reads code, then asks contracts whether they are AMM pairs. */
  private async inspect(
    addresses: string[],
  ): Promise<Map<string, LabelInfo & { cacheable: boolean }>> {
    const out = new Map<string, LabelInfo & { cacheable: boolean }>();
    const contracts: string[] = [];

    const codes = await this.codes(addresses);
    let unresolved = 0;
    addresses.forEach((a) => {
      const code = codes.get(a);
      if (code === undefined) {
        // Could not ask. Kept out of "wallets" — the cautious direction —
        // and not cached, so the next request tries again.
        unresolved += 1;
        out.set(a, { label: 'contract', name: null, cacheable: false });
      } else if (code === '0x' || code.toLowerCase().startsWith(DELEGATION_PREFIX)) {
        out.set(a, { label: 'wallet', name: null, cacheable: true });
      } else {
        contracts.push(a);
      }
    });
    if (unresolved) {
      this.log.warn(`could not read code for ${unresolved} of ${addresses.length} addresses`);
    }

    if (contracts.length === 0) return out;

    // A v2/v3-style pair answers token0 and token1. That catches every AMM
    // pool that holds its own reserves, whichever DEX deployed it.
    try {
      const results = await this.chain.client.multicall({
        multicallAddress: this.chain.network.multicall3,
        allowFailure: true,
        contracts: contracts.flatMap((a) => [
          { address: getAddress(a) as Address, abi: PAIR_ABI, functionName: 'token0' } as const,
          { address: getAddress(a) as Address, abi: PAIR_ABI, functionName: 'token1' } as const,
        ]),
      });
      contracts.forEach((a, n) => {
        const isPair =
          results[n * 2]?.status === 'success' && results[n * 2 + 1]?.status === 'success';
        out.set(a, {
          label: isPair ? 'pool' : 'contract',
          name: isPair ? 'Liquidity pool' : null,
          cacheable: true,
        });
      });
    } catch {
      for (const a of contracts) out.set(a, { label: 'contract', name: null, cacheable: false });
    }
    return out;
  }
}
