/** Mirrors TradeStep in the backend's trading.service.ts. */

export interface TokenCandidate {
  id: string;
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  liquidityUsd: number;
  warnings: string[];
}

export interface TokenLink {
  url: string;
  label: string;
}

/** One tradeable venue: the deepest pool against a given quote asset. */
export interface TokenPool {
  poolId: string;
  quoteSymbol: string;
  quoteAddress: string;
  liquidityUsd: number;
  priceUsd: number | null;
  /** How many smaller pools against this quote asset were folded in. */
  collapsed: number;
  source: 'dexscreener' | 'chain';
}

/**
 * Every field is nullable. A token minted minutes ago has no price anywhere,
 * and the UI must render its absence rather than a zero.
 */
export interface TokenStats {
  priceUsd: number | null;
  marketCap: number | null;
  fdv: number | null;
  volume24h: number | null;
  priceChange24h: number | null;
  buys24h: number | null;
  sells24h: number | null;
}

/** A search hit, with enough market context to tell eight identical tickers apart. */
export interface TokenChoice {
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

// ---------------------------------------------------------------- research

/** What kind of address a holder is. Mirrors the backend's HolderLabel. */
export type HolderKind = 'wallet' | 'pool' | 'burn' | 'token' | 'contract';

export type HoldersStatus = 'queued' | 'indexing' | 'ready' | 'failed' | 'not_indexed' | 'unavailable';

export interface HolderRow {
  rank: number;
  address: string;
  label: HolderKind;
  labelName: string | null;
  balance: string;
  /** Share of total supply, 0–100. */
  percent: number | null;
}

export interface HoldersBlock {
  status: HoldersStatus;
  progress: number;
  error: string | null;
  holderCount: number | null;
  top: HolderRow[];
  breakdown: {
    top10WalletsPercent: number | null;
    poolsPercent: number | null;
    burnedPercent: number | null;
    contractsPercent: number | null;
    basis: number;
  } | null;
  drift: { indexedPercentOfSupply: number } | null;
  asOfBlock: string | null;
}

export interface Windowed {
  m5: number | null;
  h1: number | null;
  h6: number | null;
  h24: number | null;
}

export interface TokenOverview {
  priceUsd: number | null;
  marketCap: number | null;
  fdv: number | null;
  liquidityUsd: number | null;
  volumeUsd: Windowed;
  priceChange: Windowed;
  buys: { h1: number | null; h24: number | null };
  sells: { h1: number | null; h24: number | null };
  firstPoolAt: number | null;
  pairCount: number;
  dexes: string[];
}

export interface Signal {
  tone: 'good' | 'caution' | 'info';
  text: string;
}

export interface TokenReport {
  kind: 'token_report';
  token: {
    address: string;
    symbol: string;
    name: string;
    decimals: number;
    totalSupply: string;
    imageUrl: string | null;
    websites: TokenLink[];
    socials: TokenLink[];
    owner: string | null;
  };
  market: TokenOverview | null;
  pools: TokenPool[];
  holders: HoldersBlock;
  signals: Signal[];
  explorer: string;
  asOf: string;
}

export interface VolumeToken {
  rank: number;
  address: string;
  symbol: string;
  name: string;
  imageUrl: string | null;
  priceUsd: number | null;
  marketCap: number | null;
  liquidityUsd: number | null;
  volumeUsd: Windowed;
  priceChange24h: number | null;
}

export interface TopTokens {
  kind: 'top_tokens';
  window: 'h1' | 'h6' | 'h24';
  tokens: VolumeToken[];
  observedMinutes: number;
  asOf: string;
}

export interface OverlapToken {
  address: string;
  symbol: string;
  status: HoldersStatus;
  progress: number;
  holdersCompared: number;
}

export interface OverlapHolder {
  address: string;
  tokens: Array<{ address: string; symbol: string; percent: number | null; rank: number }>;
}

export interface HolderOverlap {
  kind: 'holder_overlap';
  tokens: OverlapToken[];
  overlaps: OverlapHolder[];
  /** Present when the stored card was trimmed. */
  overlapTotal?: number;
  topN: number;
  minTokens: number;
  include: HolderKind[];
  explorer: string;
  asOf: string;
}

export interface WalletHoldings {
  kind: 'wallet_holdings';
  address: string;
  label: HolderKind;
  labelName: string | null;
  holdings: Array<{
    token: string;
    symbol: string;
    name: string;
    balance: string;
    percent: number | null;
    valueUsd: number | null;
    priceUsd: number | null;
  }>;
  indexedTokens: number;
  explorer: string;
  asOf: string;
}

export type TradeStep =
  | Portfolio
  | TokenReport
  | TopTokens
  | HolderOverlap
  | WalletHoldings
  | { kind: 'need_token'; intentId: string; ticker?: string; message: string }
  | {
      kind: 'choose_token';
      intentId: string;
      message: string;
      candidates: TokenCandidate[];
    }
  | {
      /**
       * Research disambiguation. Unlike `choose_token` this carries no
       * intentId — nobody has started a trade yet, so picking one simply opens
       * that token rather than advancing a pending order.
       */
      kind: 'token_choices';
      query: string;
      candidates: TokenChoice[];
    }
  | {
      kind: 'token_detail';
      intentId: string;
      token: {
        address: string;
        symbol: string;
        name: string;
        decimals: number;
        imageUrl: string | null;
        websites: TokenLink[];
        socials: TokenLink[];
      };
      stats: TokenStats | null;
      pools: TokenPool[];
      selectedPoolId?: string;
      /** True when there is no market data and pools came from chain state. */
      degraded: boolean;
      message: string;
    }
  | {
      kind: 'confirm';
      intentId: string;
      quoteId: string;
      message: string;
      summary: Record<string, string>;
    }
  | {
      kind: 'executed';
      intentId: string;
      txHash: string;
      explorerUrl: string;
      message: string;
    }
  | { kind: 'rejected'; message: string };

export interface TradeIntent {
  action: 'buy' | 'sell';
  ticker?: string;
  contractAddress?: string;
  amount?: number;
  currency?: string;
}

export interface TrendingToken {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  poolCount: number;
  priceUsd: number | null;
  priceChange24h: number | null;
  volume24h: number | null;
  imageUrl: string | null;
}

export interface TrendingSnapshot {
  index: { ready: boolean; pools: number; tokens: number; hydrated: number; lastBlock: string };
  tokens: TrendingToken[];
  lastRefresh: number;
  stale: boolean;
  error: string | null;
}

export interface AgentReply {
  /** Returned even when the request omitted one, so a new chat can continue. */
  conversationId: string;
  reply: string;
  toolsUsed: string[];
  truncated: boolean;
  rounds: number;
  /** A card to draw beneath the prose, when a tool produced one. */
  step: TradeStep | null;
}

export interface Me {
  user: { id: string; email: string | null };
  wallet: { address: string };
}

export interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: string;
}

export interface StoredMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  step: TradeStep | null;
  toolsUsed: string[];
  createdAt: string;
}

export interface Holding {
  address: string;
  symbol: string;
  name: string;
  balance: string;
  priceUsd: number | null;
  /** Null when unpriced — never zero, which would read as worthless. */
  valueUsd: number | null;
  imageUrl: string | null;
}

export interface Portfolio {
  kind: 'portfolio';
  address: string;
  totalUsd: number;
  unpricedCount: number;
  holdings: Holding[];
  asOf: string;
}

/** A turn in the transcript: what the user said, or what the desk replied. */
export type Entry =
  | { id: string; role: 'user'; text: string }
  /** Prose from the agent, optionally with a card the tools produced. */
  | {
      id: string;
      role: 'agent';
      text: string;
      step: TradeStep | null;
      toolsUsed: string[];
      truncated: boolean;
    }
  /** A card with no prose — emitted when the user acts on a card directly. */
  | { id: string; role: 'card'; step: TradeStep }
  | { id: string; role: 'error'; text: string };
