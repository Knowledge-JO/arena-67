import { Injectable, Logger } from '@nestjs/common';
import { formatUnits, getAddress } from 'viem';
import { ChainService } from '../chain/chain.service';
import { NATIVE_TOKEN } from '../chain/networks';
import { MarketService } from '../market/market.service';
import { ERC20_ABI } from '../trading/uniswap-v4.abi';
import { UserWalletService } from './user-wallet.service';
import { HoldingsScannerService } from './holdings-scanner.service';
import { TradeLedgerService } from './trade-ledger.service';

export interface Holding {
  address: string;
  symbol: string;
  name: string;
  /** Human-readable balance, from base units and the token's own decimals. */
  balance: string;
  priceUsd: number | null;
  /** Null when unpriced — never zero, which would read as worthless. */
  valueUsd: number | null;
  imageUrl: string | null;
}

export interface PortfolioStep {
  kind: 'portfolio';
  address: string;
  totalUsd: number;
  /** Holdings the total excludes because no price exists for them. */
  unpricedCount: number;
  holdings: Holding[];
  asOf: string;
}

/**
 * What a user's wallet holds, valued.
 *
 * Tokens come from three places, because none is complete alone: the base
 * assets always (so a fresh wallet funded with USDG shows it), every token the
 * holdings scanner has seen arrive, and every token traded through Arena —
 * the last covering the gap between a trade landing and the next scan tick.
 * Balances are always read live; the sources only decide what to ask about.
 */
@Injectable()
export class PortfolioService {
  private readonly log = new Logger(PortfolioService.name);

  constructor(
    private readonly chain: ChainService,
    private readonly market: MarketService,
    private readonly wallets: UserWalletService,
    private readonly scanner: HoldingsScannerService,
    private readonly ledger: TradeLedgerService,
  ) {}

  async forUser(userId: string): Promise<PortfolioStep> {
    const address = await this.wallets.addressOf(userId);

    const candidates = new Set<string>();
    for (const b of Object.values(this.chain.network.baseTokens)) {
      if (b.address !== NATIVE_TOKEN) candidates.add(b.address.toLowerCase());
    }
    for (const t of await this.scanner.tokensFor(address)) candidates.add(t);
    for (const t of await this.ledger.history(userId, 100)) {
      candidates.add(t.tokenAddress.toLowerCase());
    }

    const tokens = [...candidates].map((a) => getAddress(a));
    const holdings: Holding[] = [];

    // Native ETH first: it is what pays gas, so its balance matters even when
    // it is small.
    const wei = await this.chain.client.getBalance({ address });
    if (wei > 0n) {
      const eth = Number(formatUnits(wei, 18));
      const ethPrice = await this.ethPriceUsd();
      holdings.push({
        address: NATIVE_TOKEN,
        symbol: 'ETH',
        name: 'Ether',
        balance: formatUnits(wei, 18),
        priceUsd: ethPrice,
        valueUsd: ethPrice == null ? null : eth * ethPrice,
        imageUrl: null,
      });
    }

    if (tokens.length > 0) {
      const results = await this.chain.client.multicall({
        multicallAddress: this.chain.network.multicall3,
        allowFailure: true,
        contracts: tokens.flatMap((t) => [
          { address: t, abi: ERC20_ABI, functionName: 'balanceOf', args: [address] } as const,
          { address: t, abi: ERC20_ABI, functionName: 'decimals' } as const,
          { address: t, abi: ERC20_ABI, functionName: 'symbol' } as const,
          { address: t, abi: ERC20_ABI, functionName: 'name' } as const,
        ]),
      });

      const held = tokens
        .map((token, i) => {
          const [bal, dec, sym, nm] = results.slice(i * 4, i * 4 + 4);
          if (bal.status !== 'success' || dec.status !== 'success') return null;
          const raw = bal.result as bigint;
          if (raw === 0n) return null;
          return {
            token,
            raw,
            decimals: Number(dec.result),
            symbol: sym.status === 'success' ? String(sym.result) : '?',
            name: nm.status === 'success' ? String(nm.result) : '',
          };
        })
        .filter((h): h is NonNullable<typeof h> => h !== null);

      // Priced in parallel; one token with no market must not blank the rest.
      const priced = await Promise.all(
        held.map(async (h) => {
          const m = await this.market.forToken(h.token).catch(() => null);
          const priceUsd = m?.stats?.priceUsd ?? null;
          const amount = Number(formatUnits(h.raw, h.decimals));
          return {
            address: h.token,
            symbol: m?.symbol || h.symbol,
            name: m?.name || h.name,
            balance: formatUnits(h.raw, h.decimals),
            priceUsd,
            valueUsd: priceUsd == null ? null : amount * priceUsd,
            imageUrl: m?.imageUrl ?? null,
          } satisfies Holding;
        }),
      );
      holdings.push(...priced);
    }

    // Largest first; unpriced after priced, since their size is unknown.
    holdings.sort((a, b) => {
      if (a.valueUsd != null && b.valueUsd != null) return b.valueUsd - a.valueUsd;
      if (a.valueUsd != null) return -1;
      if (b.valueUsd != null) return 1;
      return 0;
    });

    return {
      kind: 'portfolio',
      address,
      totalUsd: holdings.reduce((s, h) => s + (h.valueUsd ?? 0), 0),
      unpricedCount: holdings.filter((h) => h.valueUsd == null).length,
      holdings,
      asOf: new Date().toISOString(),
    };
  }

  /** ETH's price, read off the WETH market. Null if unavailable. */
  private async ethPriceUsd(): Promise<number | null> {
    const weth = this.chain.network.baseTokens.WETH;
    if (!weth) return null;
    const m = await this.market.forToken(weth.address).catch(() => null);
    return m?.stats?.priceUsd ?? null;
  }
}
