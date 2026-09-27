import { Injectable, Logger } from '@nestjs/common';
import { getAddress, isAddress } from 'viem';
import {
  DexPair as DexPairSchema,
  DexTokenResponse,
  type DexPair,
} from './dexscreener.schema';
import type {
  TokenLink,
  TokenMarket,
  TokenOverview,
  TokenPool,
  TokenStats,
  TokenVolume,
  Windowed,
} from './market.types';
import { PoolIndexService } from '../chain/pool-index.service';

const ENDPOINT = 'https://api.dexscreener.com/latest/dex/tokens';
const PAIRS_ENDPOINT = 'https://api.dexscreener.com/latest/dex/pairs';
const SEARCH_ENDPOINT = 'https://api.dexscreener.com/latest/dex/search';
const TOKENS_BATCH_ENDPOINT = 'https://api.dexscreener.com/tokens/v1';
/** Both batch endpoints take at most thirty ids per call. */
const BATCH = 30;
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
  /** Every Robinhood pair for a token, any DEX. Shared by the trade view and the report. */
  private readonly pairCache = new Map<string, { at: number; pairs: DexPair[] }>();
  private readonly pairInflight = new Map<string, Promise<DexPair[]>>();

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
    const all = await this.allPairs(address);

    if (all.length === 0) {
      // Fresh mints are routinely absent upstream. Fall back to whatever the
      // on-chain index has seen, flagged so the UI can say it is partial.
      return this.fromChain(address);
    }

    // Stats describe the token, so they count every DEX. Pools are what the
    // trade flow can route through, so they are v4 only.
    const v4 = all.filter(isV4);
    const stats = this.statsFrom(all, address);
    const identity = this.identityFrom(all, address);
    const pools = v4.length
      ? this.collapse(v4, address)
      : (this.fromChain(address)?.pools ?? []);

    return {
      address,
      symbol: identity.symbol,
      name: identity.name,
      imageUrl: identity.imageUrl,
      websites: identity.websites,
      socials: identity.socials,
      stats,
      pools,
      degraded: v4.length === 0,
    };
  }

  /**
   * Every Robinhood Chain pair Dexscreener lists for a token, on any DEX.
   * Cached with the same window as the market view, and never throws.
   */
  async allPairs(address: string): Promise<DexPair[]> {
    if (!isAddress(address)) return [];
    const key = address.toLowerCase();
    const hit = this.pairCache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.pairs;

    const existing = this.pairInflight.get(key);
    if (existing) return existing;

    const work = this.fetchPairs(getAddress(address))
      .then((pairs) => {
        this.pairCache.set(key, { at: Date.now(), pairs });
        return pairs;
      })
      .finally(() => this.pairInflight.delete(key));
    this.pairInflight.set(key, work);
    return work;
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
    return (parsed.data.pairs ?? []).filter((p) => p.chainId === CHAIN_ID);
  }

  /**
   * Pairs by v4 pool id, thirty per request. Used to turn "these pools are
   * swapping a lot" into "these tokens are trading a lot".
   */
  async pairsByIds(ids: string[]): Promise<DexPair[]> {
    const out: DexPair[] = [];
    for (let i = 0; i < ids.length; i += BATCH) {
      const batch = ids.slice(i, i + BATCH);
      const raw = await this.fetchJson(`${PAIRS_ENDPOINT}/${CHAIN_ID}/${batch.join(',')}`, 2);
      const list = (raw as { pairs?: unknown[] } | null)?.pairs;
      out.push(...parseEach(list));
    }
    return out.filter((p) => p.chainId === CHAIN_ID);
  }

  /** Every pair for up to thirty tokens per request, grouped by token. */
  async pairsForTokens(addresses: string[]): Promise<Map<string, DexPair[]>> {
    const wanted = [...new Set(addresses.filter((a) => isAddress(a)).map((a) => a.toLowerCase()))];
    const out = new Map<string, DexPair[]>(wanted.map((a) => [a, []]));
    for (let i = 0; i < wanted.length; i += BATCH) {
      const batch = wanted.slice(i, i + BATCH);
      const raw = await this.fetchJson(`${TOKENS_BATCH_ENDPOINT}/${CHAIN_ID}/${batch.join(',')}`, 2);
      for (const p of parseEach(Array.isArray(raw) ? raw : null)) {
        if (p.chainId !== CHAIN_ID) continue;
        for (const side of [p.baseToken.address, p.quoteToken.address]) {
          out.get(side.toLowerCase())?.push(p);
        }
      }
    }
    return out;
  }

  /**
   * Tokens on this chain whose name or ticker matches, from Dexscreener's
   * text search. The pool index only knows pools opened in the last few
   * hours, so on its own it cannot find a month-old token by name — this
   * can. A pair matches on either side, so the token asked about may be the
   * quote asset; only the side that actually matches is returned.
   */
  async search(query: string): Promise<Array<{ address: `0x${string}`; symbol: string; name: string; pairs: number }>> {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const raw = await this.fetchJson(`${SEARCH_ENDPOINT}?q=${encodeURIComponent(q)}`, 2);
    const pairs = parseEach((raw as { pairs?: unknown[] } | null)?.pairs).filter((p) => p.chainId === CHAIN_ID);

    const found = new Map<string, { address: `0x${string}`; symbol: string; name: string; pairs: number }>();
    for (const p of pairs) {
      for (const side of [p.baseToken, p.quoteToken]) {
        if (!isAddress(side.address)) continue;
        const hit = side.symbol.toLowerCase().includes(q) || side.name.toLowerCase().includes(q);
        if (!hit) continue;
        const key = side.address.toLowerCase();
        const seen = found.get(key);
        if (seen) seen.pairs += 1;
        else found.set(key, { address: getAddress(side.address), symbol: side.symbol, name: side.name, pairs: 1 });
      }
    }
    return [...found.values()];
  }

  /** The report's market section. Null when no DEX lists the token. */
  async overview(address: string): Promise<TokenOverview | null> {
    const pairs = await this.allPairs(address);
    return pairs.length ? overviewOf(pairs, address) : null;
  }

  /** Ranking figures for many tokens in as few requests as the API allows. */
  async volumes(addresses: string[]): Promise<TokenVolume[]> {
    const grouped = await this.pairsForTokens(addresses);
    const out: TokenVolume[] = [];
    for (const [address, pairs] of grouped) {
      if (pairs.length === 0 || !isAddress(address)) continue;
      const o = overviewOf(pairs, address);
      const id = this.identityFrom(pairs, getAddress(address));
      out.push({
        address: getAddress(address),
        symbol: id.symbol,
        name: id.name,
        imageUrl: id.imageUrl,
        priceUsd: o.priceUsd,
        marketCap: o.marketCap,
        liquidityUsd: o.liquidityUsd,
        volumeUsd: o.volumeUsd,
        priceChange24h: o.priceChange.h24,
      });
    }
    return out;
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

/** Only Uniswap v4: a 32-byte poolId. Shorter ids are v2/v3 pair addresses we cannot route. */
function isV4(p: DexPair): boolean {
  return p.pairAddress.length === 66 && p.pairAddress.startsWith('0x');
}

/** Parses each pair on its own, so one malformed entry cannot sink a batch of thirty. */
function parseEach(list: unknown[] | null | undefined): DexPair[] {
  if (!Array.isArray(list)) return [];
  const out: DexPair[] = [];
  for (const item of list) {
    const r = DexPairSchema.safeParse(item);
    if (r.success) out.push(r.data);
  }
  return out;
}

function sumOrNull(values: Array<number | undefined>): number | null {
  const present = values.filter((v): v is number => typeof v === 'number');
  return present.length ? present.reduce((a, b) => a + b, 0) : null;
}

/**
 * Folds a token's pairs into one market picture. Volume, liquidity and
 * trade counts add up across pools; price, cap and change do not, and come
 * from the deepest pool that prices this token directly.
 */
function overviewOf(pairs: DexPair[], address: string): TokenOverview {
  const self = address.toLowerCase();
  const own = pairs
    .filter((p) => p.baseToken.address.toLowerCase() === self)
    .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
  const deepest = own[0];

  const windowed = (pick: (p: DexPair) => Windowed | undefined, add: boolean): Windowed => {
    const keys = ['m5', 'h1', 'h6', 'h24'] as const;
    const out = { m5: null, h1: null, h6: null, h24: null } as Windowed;
    for (const k of keys) {
      out[k] = add
        ? sumOrNull(pairs.map((p) => pick(p)?.[k] ?? undefined))
        : (deepest ? (pick(deepest)?.[k] ?? null) : null);
    }
    return out;
  };

  const created = pairs
    .map((p) => p.pairCreatedAt)
    .filter((t): t is number => typeof t === 'number' && t > 0);

  return {
    priceUsd: deepest?.priceUsd ?? null,
    marketCap: deepest?.marketCap ?? null,
    fdv: deepest?.fdv ?? null,
    liquidityUsd: sumOrNull(pairs.map((p) => p.liquidity?.usd)),
    volumeUsd: windowed((p) => p.volume as Windowed | undefined, true),
    priceChange: windowed((p) => p.priceChange as Windowed | undefined, false),
    buys: {
      h1: sumOrNull(pairs.map((p) => p.txns?.h1?.buys)),
      h24: sumOrNull(pairs.map((p) => p.txns?.h24?.buys)),
    },
    sells: {
      h1: sumOrNull(pairs.map((p) => p.txns?.h1?.sells)),
      h24: sumOrNull(pairs.map((p) => p.txns?.h24?.sells)),
    },
    firstPoolAt: created.length ? Math.min(...created) : null,
    pairCount: pairs.length,
    dexes: [...new Set(pairs.map((p) => p.dexId).filter(Boolean))],
  };
}
