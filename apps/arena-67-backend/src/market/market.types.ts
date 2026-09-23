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
