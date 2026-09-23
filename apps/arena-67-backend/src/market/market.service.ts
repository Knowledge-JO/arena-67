import { Injectable, Logger } from '@nestjs/common';
import { getAddress, isAddress } from 'viem';
import { DexTokenResponse, type DexPair } from './dexscreener.schema';
import type { TokenLink, TokenMarket, TokenPool, TokenStats } from './market.types';
import { PoolIndexService } from '../chain/pool-index.service';

const ENDPOINT = 'https://api.dexscreener.com/latest/dex/tokens';
/** Dexscreener's own id for Robinhood Chain. */
const CHAIN_ID = 'robinhood';
const TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 30_000;
const MAX_POOLS = 6;

interface CacheEntry {
  at: number;
  value: TokenMarket | null;
}

/**
 * Market data and venue discovery for a token.
 *
 * Dexscreener decides *which* pools exist and how deep they are. It never
 * decides what gets signed: a poolId from here is resolved to a PoolKey from
 * chain state before it can be quoted or swapped, and the quoter remains the
 * authority on what a trade actually fills at.
 *
 * The important product decision lives in `collapse()`. A token can have
 * dozens of pools — microduck has thirty — and listing them all asks the user
 * to compare venues they have no basis to judge. Showing the deepest pool per
 * quote asset turns that into a handful of readable choices ("against USDG, or
 * against ETH?") without hiding the option to trade against anything real.
 */
@Injectable()
export class MarketService {
  private readonly log = new Logger(MarketService.name);
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<TokenMarket | null>>();

  constructor(private readonly index: PoolIndexService) {}

  /**
   * Market view for a token, or null if nothing can be said about it.
   *
   * Never throws: an upstream that is slow, rate limited or simply unaware of
   * a token minted ten minutes ago must not stop the page rendering.
   */
  async forToken(address: string): Promise<TokenMarket | null> {
    if (!isAddress(address)) return null;
    const key = getAddress(address).toLowerCase();

    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

    // Collapse concurrent misses onto one request — a page load asks for the
    // same token several times over, and there is no reason to pay for it more
    // than once.
    const existing = this.inflight.get(key);
    if (existing) return existing;

    const work = this.load(getAddress(address))
      .then((value) => {
        this.cache.set(key, { at: Date.now(), value });
        return value;
      })
      .finally(() => this.inflight.delete(key));

    this.inflight.set(key, work);
    return work;
  }

  private async load(address: `0x${string}`): Promise<TokenMarket | null> {
    const pairs = await this.fetchPairs(address);

    if (pairs.length === 0) {
      // Fresh mints are routinely absent upstream. Fall back to whatever the
      // on-chain index has seen, flagged so the UI can say it is partial.
      return this.fromChain(address);
    }

    const stats = this.statsFrom(pairs, address);
    const identity = this.identityFrom(pairs, address);

    return {
      address,
      symbol: identity.symbol,
      name: identity.name,
      imageUrl: identity.imageUrl,
      websites: identity.websites,
      socials: identity.socials,
      stats,
      pools: this.collapse(pairs, address),
      degraded: false,
    };
  }

  private async fetchPairs(address: `0x${string}`): Promise<DexPair[]> {
    // One retry. Connections to this host fail intermittently at the transport
    // layer (ENETUNREACH on v6, connect timeouts on v4) often enough that a
    // single blip would otherwise drop a token to its chain-only view for a
    // full cache window.
    const raw = await this.fetchJson(`${ENDPOINT}/${address}`, 2);
    if (raw === null) return [];

    const parsed = DexTokenResponse.safeParse(raw);
    if (!parsed.success) {
      this.log.warn(`dexscreener payload did not parse for ${address}`);
      return [];
    }

    return (parsed.data.pairs ?? []).filter(
      (p) =>
        p.chainId === CHAIN_ID &&
        // Only Uniswap v4. A 32-byte pairAddress is a poolId; anything shorter
        // is a v2/v3 pair address we have no swap path for, and feeding one to
        // the PoolKey resolver would just fail later and less clearly.
        p.pairAddress.length === 66 &&
        p.pairAddress.startsWith('0x'),
    );
  }

  private async fetchJson(url: string, attempts: number): Promise<unknown> {
    for (let i = 0; i < attempts; i++) {
      try {
        const res = await fetch(url, {
          signal: AbortSignal.timeout(TIMEOUT_MS),
          headers: { accept: 'application/json' },
        });
        // A 4xx is an answer, not a blip — retrying it just burns the budget.
        if (res.status >= 400 && res.status < 500) {
          this.log.warn(`dexscreener ${res.status} for ${url}`);
          return null;
        }
        if (!res.ok) throw new Error(`status ${res.status}`);
        return await res.json();
      } catch (err) {
        const last = i === attempts - 1;
        this.log.warn(
          `dexscreener ${last ? 'failed' : 'retrying'}: ${(err as Error).message}`,
        );
        if (last) return null;
        await new Promise((r) => setTimeout(r, 400));
      }
    }
    return null;
  }

  /** Deepest pool per quote asset, richest first. */
  private collapse(pairs: DexPair[], token: `0x${string}`): TokenPool[] {
    const best = new Map<string, { pool: TokenPool; count: number }>();
    const self = token.toLowerCase();

    for (const p of pairs) {
      // Our token can sit on either side of the pair; the other side is the
      // quote asset. Assuming it is always `baseToken` breaks for anything
      // that itself serves as a quote currency.
      const baseIsSelf = p.baseToken.address.toLowerCase() === self;
      const other = baseIsSelf ? p.quoteToken : p.baseToken;
      if (!isAddress(other.address)) continue;

      const quoteAddress = getAddress(other.address);
      const key = quoteAddress.toLowerCase();
      const liquidityUsd = p.liquidity?.usd ?? 0;

      const candidate: TokenPool = {
        poolId: p.pairAddress as `0x${string}`,
        quoteSymbol: other.symbol || key.slice(0, 8),
        quoteAddress,
        liquidityUsd,
        priceUsd: baseIsSelf ? (p.priceUsd ?? null) : null,
        collapsed: 0,
        source: 'dexscreener',
      };

      const seen = best.get(key);
      if (!seen) {
        best.set(key, { pool: candidate, count: 1 });
      } else {
        seen.count += 1;
        if (liquidityUsd > seen.pool.liquidityUsd) seen.pool = candidate;
      }
    }

    return [...best.values()]
      .map(({ pool, count }) => ({ ...pool, collapsed: count - 1 }))
      .sort((a, b) => b.liquidityUsd - a.liquidityUsd)
      .slice(0, MAX_POOLS);
  }

  /** Stats are read off the deepest pair, which is the least noisy quote. */
  private statsFrom(pairs: DexPair[], token: `0x${string}`): TokenStats | null {
    const self = token.toLowerCase();
    const own = pairs
      .filter((p) => p.baseToken.address.toLowerCase() === self)
      .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
    const deepest = own[0];
    if (!deepest) return null;

    // Volume is summed across every pool; price and cap are not additive and
    // are taken from the deepest venue.
    const volume24h = pairs.reduce((sum, p) => sum + (p.volume?.h24 ?? 0), 0);
    const buys = pairs.reduce((s, p) => s + (p.txns?.h24?.buys ?? 0), 0);
    const sells = pairs.reduce((s, p) => s + (p.txns?.h24?.sells ?? 0), 0);

    return {
      priceUsd: deepest.priceUsd ?? null,
      marketCap: deepest.marketCap ?? null,
      fdv: deepest.fdv ?? null,
      volume24h: volume24h || null,
      priceChange24h: deepest.priceChange?.h24 ?? null,
      buys24h: buys || null,
      sells24h: sells || null,
    };
  }

  private identityFrom(pairs: DexPair[], token: `0x${string}`) {
    const self = token.toLowerCase();
    const own =
      pairs.find((p) => p.baseToken.address.toLowerCase() === self)?.baseToken ??
      pairs.find((p) => p.quoteToken.address.toLowerCase() === self)?.quoteToken;

    const info = pairs.find((p) => p.info)?.info;
    const links = (
      list: Array<{ url: string; label?: string; type?: string }> | undefined,
      fallback: string,
    ): TokenLink[] =>
      (list ?? []).map((l) => ({ url: l.url, label: l.label ?? l.type ?? fallback }));

    return {
      symbol: own?.symbol ?? '',
      name: own?.name ?? '',
      imageUrl: info?.imageUrl ?? null,
      websites: links(info?.websites, 'Website'),
      socials: links(info?.socials, 'Link'),
    };
  }

  /**
   * Chain-only view for tokens Dexscreener has never heard of.
   *
   * There is no price, cap or volume here — those genuinely do not exist yet —
   * and pools carry no USD depth, so they cannot be ranked. `degraded` says so
   * rather than letting the UI imply the numbers are merely zero.
   */
  private fromChain(address: `0x${string}`): TokenMarket | null {
    const seen = new Map<string, TokenPool>();

    for (const pool of this.index.poolsForToken(address)) {
      const baseIsSelf = pool.currency0.toLowerCase() === address.toLowerCase();
      const quoteAddress = baseIsSelf ? pool.currency1 : pool.currency0;
      const key = quoteAddress.toLowerCase();
      if (seen.has(key)) continue;
      seen.set(key, {
        poolId: pool.id as `0x${string}`,
        quoteSymbol: this.index.symbolOf(quoteAddress) ?? key.slice(0, 8),
        quoteAddress: getAddress(quoteAddress),
        liquidityUsd: 0,
        priceUsd: null,
        collapsed: 0,
        source: 'chain',
      });
    }

    if (seen.size === 0) return null;

    const meta = this.index.metaOf(address);
    return {
      address,
      symbol: meta?.symbol ?? '',
      name: meta?.name ?? '',
      imageUrl: null,
      websites: [],
      socials: [],
      stats: null,
      pools: [...seen.values()].slice(0, MAX_POOLS),
      degraded: true,
    };
  }
}
