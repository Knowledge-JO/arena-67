import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { parseAbiItem, type Address } from 'viem';
import { ChainService } from './chain.service';
import { NATIVE_TOKEN } from './networks';
import { ERC20_ABI } from '../trading/uniswap-v4.abi';
import { MAX_SPAN } from '../holders/transfer-fold';

export const INITIALIZE_EVENT = parseAbiItem(
  'event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)',
);

export interface PoolRecord {
  id: string;
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
  block: bigint;
}

export interface TokenMeta {
  address: Address;
  symbol: string;
  name: string;
  decimals: number;
  poolCount: number;
}

const CHUNK = 100_000n;
/** Contracts a single cold search may hydrate before answering. */
const SEARCH_HYDRATE_LIMIT = 100;

/**
 * An index of live Uniswap v4 pools, built by replaying the PoolManager's
 * Initialize events.
 *
 * This replaces guessing at fee tiers, which measurement showed does not work
 * on this chain. Over a 1,929-pool sample, only 12% were reachable by probing
 * the canonical tiers with no hook:
 *
 *   - 31% of pools use fee 0x800000, the v4 dynamic-fee flag, where the real
 *     fee lives in a hook rather than the PoolKey.
 *   - 38% attach a hook at all, and a hookless probe cannot see any of them.
 *   - fee and tickSpacing do not pair canonically here. Plenty of pools run
 *     fee 500 with tickSpacing 1 rather than the usual 10, and launchpad
 *     pools use combinations like fee 810000 / tickSpacing 19988.
 *
 * Reading the pools that actually exist sidesteps all of that, and gives
 * ticker search for free: a token is discoverable precisely when something
 * has opened a market for it.
 */
@Injectable()
export class PoolIndexService implements OnModuleInit {
  private readonly log = new Logger(PoolIndexService.name);

  private readonly pools = new Map<string, PoolRecord>();
  private readonly byToken = new Map<string, Set<string>>();
  private readonly meta = new Map<string, TokenMeta>();
  /**
   * poolId -> PoolKey, for pools outside the backfill window. A PoolKey is
   * immutable once initialised, so this never needs invalidating. A null entry
   * means the chain confirmed no such pool — cached too, since that answer
   * cannot change either.
   */
  private readonly resolved = new Map<string, PoolRecord | null>();
  private lastBlock = 0n;
  private ready = false;
  private markReady!: () => void;
  /** Settles when the first backfill finishes. Until then the index holds only the oldest pools. */
  private readonly readyPromise = new Promise<void>((resolve) => (this.markReady = resolve));

  constructor(
    private readonly chain: ChainService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    void this.start();
  }

  /**
   * Starts the backfill. Nothing awaits it — boot does not wait on the pool
   * index, and a failed head read is retried here rather than failing the
   * whole server's startup, which it used to.
   */
  private async start(attempt = 1): Promise<void> {
    let head: bigint;
    try {
      head = await this.chain.latestBlock();
    } catch (e) {
      const wait = Math.min(60, 5 * attempt);
      this.log.warn(`pool index cannot read the chain head yet, retrying in ${wait}s: ${(e as Error).message.split('\n')[0]}`);
      setTimeout(() => void this.start(attempt + 1), wait * 1_000);
      return;
    }
    const span = BigInt(this.config.get<number>('POOL_INDEX_SPAN') ?? 200_000);
    // Backfill runs unawaited: a cold index should not hold up the API, and
    // every read path already copes with an index that is still filling.
    void this.scan(head - span, head)
      .then(async () => {
        this.ready = true;
        this.markReady();
        this.log.log(
          `pool index ready — ${this.pools.size} pools, ${this.byToken.size} tokens`,
        );
        // Warm the metadata cache in the background. Without this the first
        // search of a session pays to hydrate every indexed token — a thousand
        // contracts over ten multicalls — and times out before answering.
        await this.hydrate([...this.byToken.keys()] as Address[]);
        this.log.log(`metadata warm — ${this.meta.size} tokens hydrated`);
      })
      .catch((e) => this.log.error(`initial pool scan failed: ${e.message}`));
  }

  /** Catches up from the last indexed block. Cheap once warm. */
  @Cron(CronExpression.EVERY_MINUTE)
  async catchUp(): Promise<void> {
    if (!this.lastBlock) return;
    try {
      const head = await this.chain.latestBlock();
      if (head > this.lastBlock) await this.scan(this.lastBlock + 1n, head);
    } catch (e) {
      this.log.warn(`pool index catch-up failed: ${(e as Error).message}`);
    }
  }

  private async scan(from: bigint, to: bigint): Promise<void> {
    for (let start = from; start <= to; start += CHUNK) {
      const end = start + CHUNK - 1n > to ? to : start + CHUNK - 1n;
      try {
        const logs = await this.chain.backgroundClient.getLogs({
          address: this.chain.network.uniswapV4.POOL_MANAGER,
          event: INITIALIZE_EVENT,
          fromBlock: start,
          toBlock: end,
        });
        for (const l of logs) {
          const a = l.args as {
            id: string;
            currency0: Address;
            currency1: Address;
            fee: number;
            tickSpacing: number;
            hooks: Address;
          };
          const rec: PoolRecord = {
            id: a.id,
            currency0: a.currency0,
            currency1: a.currency1,
            fee: Number(a.fee),
            tickSpacing: Number(a.tickSpacing),
            hooks: a.hooks,
            block: l.blockNumber ?? 0n,
          };
          this.pools.set(rec.id, rec);
          this.link(rec.currency0, rec.id);
          this.link(rec.currency1, rec.id);
        }
      } catch (e) {
        // One bad chunk should not abandon the whole backfill.
        this.log.warn(`chunk ${start}-${end} failed: ${(e as Error).message}`);
      }
      this.lastBlock = end;
    }
  }

  private link(token: Address, poolId: string): void {
    const k = token.toLowerCase();
    let set = this.byToken.get(k);
    if (!set) this.byToken.set(k, (set = new Set()));
    set.add(poolId);
  }

  /** Every indexed pool trading this exact pair, most recent first. */
  poolsFor(a: Address, b: Address): PoolRecord[] {
    const [x, y] = [a.toLowerCase(), b.toLowerCase()];
    const ids = this.byToken.get(x);
    if (!ids) return [];
    const out: PoolRecord[] = [];
    for (const id of ids) {
      const p = this.pools.get(id);
      if (!p) continue;
      const pair = [p.currency0.toLowerCase(), p.currency1.toLowerCase()];
      if (pair.includes(y)) out.push(p);
    }
    return out.sort((p, q) => (q.block > p.block ? 1 : -1));
  }

  /**
   * Recovers a pool's key from its id, looking beyond the indexed window.
   *
   * The index only holds a rolling ~5.6h of pool creations, but Dexscreener
   * happily reports pools years older — microduck's deepest venue was created
   * at block 47.4M against a hook, which no amount of tier-guessing would
   * reconstruct. A poolId is keccak(PoolKey) and cannot be reversed, but
   * `Initialize` declares `id` as an indexed topic, so a filtered getLogs
   * recovers the key. The RPC allows at most ten million blocks per query, so
   * the search walks back from the head in windows of that size — eight or so
   * cheap calls at worst, and the answer is cached for good.
   *
   * Throws on RPC failure rather than returning null: "the chain says no such
   * pool" and "we could not ask" must not collapse into the same answer, or a
   * network blip would be cached as a permanent negative.
   */
  async resolveById(poolId: string): Promise<PoolRecord | null> {
    const key = poolId.toLowerCase();

    const indexed = this.pools.get(poolId) ?? this.pools.get(key);
    if (indexed) return indexed;

    if (this.resolved.has(key)) return this.resolved.get(key) ?? null;

    const head = await this.chain.latestBlock();
    let found: Awaited<ReturnType<typeof this.initializeLogs>>[number] | undefined;
    for (let to = head; to >= 0n && !found; to -= MAX_SPAN) {
      const from = to - MAX_SPAN + 1n > 0n ? to - MAX_SPAN + 1n : 0n;
      found = (await this.initializeLogs(key as `0x${string}`, from, to))[0];
    }

    if (!found) {
      this.resolved.set(key, null);
      return null;
    }

    const a = found.args as {
      currency0: Address;
      currency1: Address;
      fee: number;
      tickSpacing: number;
      hooks: Address;
    };
    const record: PoolRecord = {
      id: poolId,
      currency0: a.currency0,
      currency1: a.currency1,
      fee: Number(a.fee),
      tickSpacing: Number(a.tickSpacing),
      hooks: a.hooks,
      block: found.blockNumber ?? 0n,
    };

    this.resolved.set(key, record);
    this.log.debug(`resolved pool ${key.slice(0, 12)}… from block ${record.block}`);
    return record;
  }

  private initializeLogs(id: `0x${string}`, fromBlock: bigint, toBlock: bigint) {
    return this.chain.client.getLogs({
      address: this.chain.network.uniswapV4.POOL_MANAGER,
      event: INITIALIZE_EVENT,
      args: { id },
      fromBlock,
      toBlock,
    });
  }

  /**
   * Resolves a pool and proves it actually trades the token in hand.
   *
   * The poolId reaches us from the browser, having originally come from a
   * third-party API. Neither is grounds to sign against it. Checking that the
   * recovered key really contains this token is what stops a swapped id
   * pointing the trade at a different pair — the id is opaque, so nothing
   * about it looks wrong until the funds have moved.
   */
  async resolveForToken(poolId: string, token: Address): Promise<PoolRecord> {
    const pool = await this.resolveById(poolId);
    if (!pool) throw new Error('That pool does not exist on this chain.');

    const want = token.toLowerCase();
    const pair = [pool.currency0.toLowerCase(), pool.currency1.toLowerCase()];
    if (!pair.includes(want)) {
      this.log.warn(`pool ${poolId.slice(0, 12)}… does not trade ${token}`);
      throw new Error('That pool does not trade this token.');
    }
    return pool;
  }

  /** Every indexed pool that touches this token, regardless of the other side. */
  poolsForToken(token: Address): PoolRecord[] {
    const ids = this.byToken.get(token.toLowerCase());
    if (!ids) return [];
    const out: PoolRecord[] = [];
    for (const id of ids) {
      const p = this.pools.get(id);
      if (p) out.push(p);
    }
    return out.sort((a, b) => (b.block > a.block ? 1 : -1));
  }

  /** Cached ERC-20 metadata, if this token has been hydrated. */
  metaOf(token: Address): TokenMeta | undefined {
    return this.meta.get(token.toLowerCase());
  }

  symbolOf(token: Address): string | undefined {
    if (token.toLowerCase() === NATIVE_TOKEN.toLowerCase()) return 'ETH';
    return this.meta.get(token.toLowerCase())?.symbol;
  }

  /**
   * Ticker search over indexed tokens. Exact symbol matches rank above
   * prefixes, then by how many pools reference the token — a rough but honest
   * proxy for "which Trump did you mean", since the contract nobody has opened
   * a market for is rarely the one being asked about.
   */
  async search(query: string, limit = 8): Promise<TokenMeta[]> {
    const q = query.trim().toLowerCase();
    if (!q) return [];

    // Hydrate at most one batch per call. The boot warm-up normally means
    // there is nothing left to do; this only matters if a search lands while
    // the cache is still filling, and there it keeps the call bounded instead
    // of letting it inherit the whole backlog.
    const cold = [...this.byToken.keys()].filter(
      (a) => !this.meta.has(a),
    ) as Address[];
    if (cold.length) await this.hydrate(cold.slice(0, SEARCH_HYDRATE_LIMIT));

    const scored: Array<{ m: TokenMeta; score: number }> = [];
    for (const m of this.meta.values()) {
      const sym = m.symbol.toLowerCase();
      const name = m.name.toLowerCase();
      let score = 0;
      if (sym === q) score = 100;
      else if (name === q) score = 90;
      else if (sym.startsWith(q)) score = 70;
      else if (name.startsWith(q)) score = 60;
      else if (sym.includes(q) || name.includes(q)) score = 40;
      if (score) scored.push({ m, score });
    }
    return scored
      .sort((a, b) => b.score - a.score || b.m.poolCount - a.m.poolCount)
      .slice(0, limit)
      .map((s) => s.m);
  }

  /** Waits for the first backfill, up to `timeoutMs`. True if the index is ready. */
  async whenReady(timeoutMs: number): Promise<boolean> {
    if (this.ready) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => (timer = setTimeout(resolve, timeoutMs)));
    await Promise.race([this.readyPromise, timeout]);
    clearTimeout(timer);
    return this.ready;
  }

  /**
   * Tokens by their most recent pool opening, newest first — candidates for
   * "new tokens". ETH and the dollar bases are the other side, not the token.
   * A fresh pool for an old token lands here too; the caller checks age.
   */
  recentTokens(limit: number): Address[] {
    const excluded = new Set<string>([NATIVE_TOKEN.toLowerCase()]);
    for (const base of Object.values(this.chain.network.baseTokens)) {
      excluded.add(base.address.toLowerCase());
    }
    const newest = [...this.pools.values()].sort((p, q) => (q.block > p.block ? 1 : q.block < p.block ? -1 : 0));
    const out: Address[] = [];
    const seen = new Set<string>();
    for (const p of newest) {
      for (const t of [p.currency0, p.currency1]) {
        const k = t.toLowerCase();
        if (excluded.has(k) || seen.has(k)) continue;
        seen.add(k);
        out.push(t);
      }
      if (out.length >= limit) break;
    }
    return out.slice(0, limit);
  }

  /** Batch-reads ERC-20 metadata through Multicall3, caching as it goes. */
  private async hydrate(tokens: Address[]): Promise<void> {
    const todo = tokens.filter(
      (t) =>
        !this.meta.has(t.toLowerCase()) &&
        t.toLowerCase() !== NATIVE_TOKEN.toLowerCase(),
    );
    if (!todo.length) return;

    for (let i = 0; i < todo.length; i += 100) {
      const batch = todo.slice(i, i + 100);
      try {
        const results = await this.chain.client.multicall({
          multicallAddress: this.chain.network.multicall3,
          allowFailure: true,
          contracts: batch.flatMap((address) => [
            { address, abi: ERC20_ABI, functionName: 'symbol' } as const,
            { address, abi: ERC20_ABI, functionName: 'name' } as const,
            { address, abi: ERC20_ABI, functionName: 'decimals' } as const,
          ]),
        });
        batch.forEach((address, n) => {
          const [s, nm, d] = results.slice(n * 3, n * 3 + 3);
          if (s.status !== 'success' || d.status !== 'success') return;
          this.meta.set(address.toLowerCase(), {
            address,
            symbol: String(s.result),
            name: nm.status === 'success' ? String(nm.result) : String(s.result),
            decimals: Number(d.result),
            poolCount: this.byToken.get(address.toLowerCase())?.size ?? 0,
          });
        });
      } catch (e) {
        this.log.warn(`metadata batch failed: ${(e as Error).message}`);
      }
    }
  }

  stats() {
    return {
      ready: this.ready,
      pools: this.pools.size,
      tokens: this.byToken.size,
      hydrated: this.meta.size,
      lastBlock: this.lastBlock.toString(),
    };
  }
}
