/** Mirrors the Arena 67 backend's public shapes. */

export interface TokenLink {
  url: string;
  label: string;
}

export interface TokenPool {
  poolId: string;
  quoteSymbol: string;
  quoteAddress: string;
  liquidityUsd: number;
  priceUsd: number | null;
  collapsed: number;
  source: 'dexscreener' | 'chain';
}

export interface TokenStats {
  priceUsd: number | null;
  marketCap: number | null;
  fdv: number | null;
  volume24h: number | null;
  priceChange24h: number | null;
  buys24h: number | null;
  sells24h: number | null;
}

export interface TokenDetail {
  address: string;
  isToken: boolean;
  reason?: string;
  symbol?: string;
  name?: string;
  decimals?: number;
  market: {
    imageUrl: string | null;
    websites: TokenLink[];
    socials: TokenLink[];
    stats: TokenStats | null;
    pools: TokenPool[];
    degraded: boolean;
  } | null;
}

export interface TokenCandidate {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  poolCount: number;
  priceUsd: number | null;
  marketCap: number | null;
  volume24h: number | null;
  priceChange24h: number | null;
  imageUrl: string | null;
}

export interface TokenSearchResult {
  query: string;
  results: TokenCandidate[];
}

/** One of the most traded tokens over 24h, by dollar volume. */
export interface TrendingToken {
  address: string;
  symbol: string;
  name: string;
  priceUsd: number | null;
  priceChange24h: number | null;
  volume24h: number | null;
  marketCap: number | null;
  /** When its first trading pool opened (epoch ms). */
  launchedAt: number | null;
  imageUrl: string | null;
}

export interface TrendingSnapshot {
  index: {
    ready: boolean;
    pools: number;
    tokens: number;
    hydrated: number;
    lastBlock: string;
  };
  window: 'h24';
  tokens: TrendingToken[];
  /** Minutes of swaps the backend has seen; under 1440, only tokens traded in them are ranked. */
  observedMinutes: number;
  lastRefresh: number;
  stale: boolean;
  error: string | null;
}

export interface WalletStatus {
  address: string | null;
  available: boolean;
  reason: string | null;
}

export type TradeStep = Record<string, unknown> & { kind: string };
