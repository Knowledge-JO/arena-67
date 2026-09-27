/** One tradeable venue for a token: the deepest pool against a given quote asset. */
export interface TokenPool {
  /** 32-byte Uniswap v4 poolId. Resolved to a PoolKey on chain before use. */
  poolId: `0x${string}`;
  quoteSymbol: string;
  quoteAddress: `0x${string}`;
  liquidityUsd: number;
  priceUsd: number | null;
  /** How many pools against this quote asset were collapsed into this row. */
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

export interface TokenLink {
  url: string;
  label: string;
}

export interface TokenMarket {
  address: `0x${string}`;
  symbol: string;
  name: string;
  imageUrl: string | null;
  websites: TokenLink[];
  socials: TokenLink[];
  /** Null when no market data exists — render the page without it, not zeros. */
  stats: TokenStats | null;
  pools: TokenPool[];
  /** Where pools came from, so the UI can say when it is flying blind. */
  degraded: boolean;
}

/** A figure over Dexscreener's four windows. Null where a window is missing. */
export interface Windowed {
  m5: number | null;
  h1: number | null;
  h6: number | null;
  h24: number | null;
}

/**
 * Everything the market knows about a token, across every DEX that lists it.
 *
 * Wider than `TokenStats` on purpose: stats describe what the trade flow can
 * act on (v4 only), this describes the token. A token trading mostly on a v2
 * fork still has that volume, and a report that left it out would understate
 * it.
 */
export interface TokenOverview {
  priceUsd: number | null;
  marketCap: number | null;
  fdv: number | null;
  /** Summed across every pool that holds it. */
  liquidityUsd: number | null;
  volumeUsd: Windowed;
  priceChange: Windowed;
  buys: { h1: number | null; h24: number | null };
  sells: { h1: number | null; h24: number | null };
  /** Earliest pool creation we know of, epoch ms. A floor on the token's age. */
  firstPoolAt: number | null;
  pairCount: number;
  dexes: string[];
}

/** A token's 24h figures, for ranking many at once. */
export interface TokenVolume {
  address: `0x${string}`;
  symbol: string;
  name: string;
  imageUrl: string | null;
  priceUsd: number | null;
  marketCap: number | null;
  liquidityUsd: number | null;
  volumeUsd: Windowed;
  priceChange24h: number | null;
  /** Price change over each window, in percent. */
  priceChange: Windowed;
  /** Earliest pool creation Dexscreener knows of, epoch ms — its launch, in practice. */
  firstPoolAt: number | null;
}
