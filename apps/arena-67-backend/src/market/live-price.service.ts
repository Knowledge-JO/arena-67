import { Injectable, Logger } from '@nestjs/common';
import { getAddress, isAddress, parseAbi, type Address } from 'viem';
import { ChainService } from '../chain/chain.service';
import { NATIVE_TOKEN } from '../chain/networks';
import { PoolIndexService } from '../chain/pool-index.service';
import { MarketService } from './market.service';
import type { TokenOverview } from './market.types';
import type { DexPair } from './dexscreener.schema';

const STATE_VIEW_ABI = parseAbi([
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
  'function decimals() view returns (uint8)',
]);

/** One chain read serves every viewer of a token within this window. */
const SLOT0_TTL_MS = 2_000;
/** How long a last good slot0 stands in for a failed read. */
const SLOT0_FALLBACK_MS = 60_000;
const Q96 = 2 ** 96;

export interface LiveMarket {
  address: string;
  /** From the deepest pool's current on-chain price when possible. */
  priceUsd: number | null;
  marketCap: number | null;
  priceChange24h: number | null;
  /** 'chain' when the price was read from the pool this instant; 'dexscreener' otherwise. */
  source: 'chain' | 'dexscreener';
  /** The pool the live price came from. */
  pool: { quoteSymbol: string; liquidityUsd: number } | null;
  /** Liquidity, volume, trade counts: Dexscreener, refreshed every 30s. */
  market: TokenOverview | null;
  at: string;
}

/**
 * Current price for a token, read from its deepest Uniswap v4 pool.
 *
 * Dexscreener figures lag by up to its cache window; a pool's slot0 is current
 * to the block (~0.1s here). Measured against Dexscreener on three AI pools the
 * two agreed within 0.4% — the gap being Dexscreener's lag, not the maths.
 *
 * The pool price is in the quote asset (USDG, ETH, or another token), so it
 * is converted to USD at the quote's own rate, taken from the same pair on
 * Dexscreener (priceUsd ÷ priceNative). The quote moves far less than the
 * memecoin being priced, so a 30-second-old rate for it is a small error on a
 * live price rather than a stale price.
 *
 * Aggregates — liquidity, volume, buy and sell counts — only exist upstream
 * and are served from the market cache as they are.
 */
@Injectable()
export class LivePriceService {
  private readonly log = new Logger(LivePriceService.name);
  private readonly decimals = new Map<string, number>();
  private readonly slot0 = new Map<string, { at: number; sqrt: bigint }>();
  private readonly inflight = new Map<string, Promise<bigint | null>>();

  constructor(
    private readonly chain: ChainService,
    private readonly index: PoolIndexService,
    private readonly market: MarketService,
  ) {}

  async live(address: string): Promise<LiveMarket | null> {
    if (!isAddress(address)) return null;
    const token = getAddress(address);
    const [pairs, overview] = await Promise.all([this.market.allPairs(token), this.market.overview(token)]);

    const base: LiveMarket = {
      address: token,
      priceUsd: overview?.priceUsd ?? null,
      marketCap: overview?.marketCap ?? null,
      priceChange24h: overview?.priceChange.h24 ?? null,
      source: 'dexscreener',
      pool: null,
      market: overview,
      at: new Date().toISOString(),
    };

    const pair = deepestV4Pair(pairs, token);
    if (!pair || !pair.priceUsd || !pair.priceNative) return base;

    try {
      const inQuote = await this.priceInQuote(pair.pairAddress, token);
      if (inQuote == null || !Number.isFinite(inQuote) || inQuote <= 0) return base;

      const quoteUsd = pair.priceUsd / pair.priceNative;
      const priceUsd = inQuote * quoteUsd;
      const ref = overview?.priceUsd;

      return {
        ...base,
        priceUsd,
        // Market cap and 24h change move with price; rescale the upstream
        // figures by how far the price has moved since they were taken.
        marketCap: overview?.marketCap && ref ? overview.marketCap * (priceUsd / ref) : base.marketCap,
        priceChange24h:
          overview?.priceChange.h24 != null && ref
            ? ((priceUsd / (ref / (1 + overview.priceChange.h24 / 100))) - 1) * 100
            : base.priceChange24h,
        source: 'chain',
        pool: {
          quoteSymbol:
            pair.baseToken.address.toLowerCase() === token.toLowerCase()
              ? pair.quoteToken.symbol
              : pair.baseToken.symbol,
          liquidityUsd: pair.liquidity?.usd ?? 0,
        },
      };
    } catch (err) {
      // A failed chain read falls back to the upstream price, never to nothing.
      this.log.debug(`live price fell back for ${token}: ${(err as Error).message.split('\n')[0]}`);
      return base;
    }
  }

  /** The token's price in the pool's other asset, from slot0. */
  private async priceInQuote(poolId: string, token: Address): Promise<number | null> {
    const key = await this.index.resolveById(poolId);
    if (!key) return null;
    const [sqrt, d0, d1] = await Promise.all([
      this.readSlot0(poolId),
      this.decimalsOf(key.currency0),
      this.decimalsOf(key.currency1),
    ]);
    if (sqrt == null || sqrt === 0n) return null;

    // sqrtPriceX96² is currency1 per currency0, in base units.
    const ratio = Number(sqrt) / Q96;
    const oneIn0 = ratio * ratio * 10 ** (d0 - d1);
    return key.currency0.toLowerCase() === token.toLowerCase() ? oneIn0 : 1 / oneIn0;
  }

  private async readSlot0(poolId: string): Promise<bigint | null> {
    const hit = this.slot0.get(poolId);
    if (hit && Date.now() - hit.at < SLOT0_TTL_MS) return hit.sqrt;
    const pending = this.inflight.get(poolId);
    if (pending) return pending;

    const work = this.chain.client
      .readContract({
        address: this.chain.network.uniswapV4.STATE_VIEW,
        abi: STATE_VIEW_ABI,
        functionName: 'getSlot0',
        args: [poolId as `0x${string}`],
      })
      .then(([sqrt]) => {
        this.slot0.set(poolId, { at: Date.now(), sqrt });
        return sqrt;
      })
      .catch((err) => {
        // A missed read keeps the last on-chain price for a minute. Falling
        // back to Dexscreener instead made the price jump to its lagging
        // figure and back on the next poll.
        const last = this.slot0.get(poolId);
        if (last && Date.now() - last.at < SLOT0_FALLBACK_MS) return last.sqrt;
        throw err;
      })
      .finally(() => this.inflight.delete(poolId));
    this.inflight.set(poolId, work);
    return work;
  }

  private async decimalsOf(currency: Address): Promise<number> {
    const k = currency.toLowerCase();
    if (k === NATIVE_TOKEN) return 18;
    const known = this.decimals.get(k) ?? this.index.metaOf(currency)?.decimals;
    if (known != null) return known;
    const d = Number(
      await this.chain.client.readContract({ address: currency, abi: STATE_VIEW_ABI, functionName: 'decimals' }),
    );
    this.decimals.set(k, d);
    return d;
  }
}

/** The deepest v4 pool that prices this token directly. */
function deepestV4Pair(pairs: DexPair[], token: string): DexPair | null {
  const self = token.toLowerCase();
  return (
    pairs
      .filter(
        (p) =>
          p.pairAddress.length === 66 &&
          p.baseToken.address.toLowerCase() === self &&
          p.priceUsd != null &&
          p.priceNative != null,
      )
      .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0] ?? null
  );
}
