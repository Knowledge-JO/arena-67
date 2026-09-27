/** Mirrors TradeStep in the backend's trading.service.ts. */

/** Paper money on mainnet prices, or the user's real wallet. */
export type TradingMode = 'sandbox' | 'live';

export interface PaperFill {
  spent: string;
  received: string;
  valueUsd: number;
  feeUsd: number;
  feeAsset: string;
  realizedUsd: number | null;
}

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

/** Live figures for an open report card. Mirrors the backend's LiveMarket. */
export interface LiveMarket {
  address: string;
  priceUsd: number | null;
  marketCap: number | null;
  priceChange24h: number | null;
  /** 'chain' = read from the pool this instant; 'dexscreener' = up to 30s old. */
  source: 'chain' | 'dexscreener';
  pool: { quoteSymbol: string; liquidityUsd: number } | null;
  market: TokenOverview | null;
  at: string;
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
      /** Buying or selling: what the amount box is denominated in. Absent on old cards. */
      action?: 'buy' | 'sell';
      /** Once a venue is chosen: what is held of the asset being spent. */
      available?: { amount: string; symbol: string } | null;
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
      /** Absent on cards saved before the sandbox existed: those were live. */
      mode?: TradingMode;
    }
  | {
      kind: 'executed';
      intentId: string;
      /** Live trades only; a paper fill has no transaction. */
      txHash?: string;
      explorerUrl?: string;
      message: string;
      mode?: TradingMode;
      paper?: PaperFill;
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
  marketCap?: number | null;
  /** When its first trading pool opened (epoch ms) — its launch, in practice. */
  launchedAt?: number | null;
  imageUrl: string | null;
}

/** Which list the dashboard sidebar shows: most traded over a window, or new launches. */
export type SidebarView = 'h1' | 'h6' | 'h24' | 'new';

export interface SidebarToken {
  address: string;
  symbol: string;
  name: string;
  imageUrl: string | null;
  priceUsd: number | null;
  marketCap: number | null;
  liquidityUsd: number | null;
  /** Over the list's window; 24h for new tokens. */
  volumeUsd: number | null;
  priceChangePct: number | null;
  /** When its first trading pool opened (epoch ms). */
  launchedAt: number | null;
}

export interface SidebarList {
  view: SidebarView;
  tokens: SidebarToken[];
  /** How many the list holds in all; "load more" stops here. */
  total: number;
  /** Volume lists: minutes of trading seen so far. Below the window, the list is still filling. */
  observedMinutes: number | null;
  asOf: string;
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
  mode: TradingMode;
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
  /** Sandbox only: what the holding cost, and its profit at today's price. */
  costUsd?: number;
  pnlUsd?: number | null;
  pnlPct?: number | null;
  /** Sandbox: cash (ETH, USDG) pays for trades; positions are what was bought. */
  kind?: 'cash' | 'position';
  /** Sandbox: average price paid per token. */
  avgPriceUsd?: number | null;
  /** Sandbox: profit already locked in on this asset by earlier sales. */
  realizedUsd?: number;
  /** Sandbox: share of the portfolio's value, 0–100. */
  allocationPct?: number | null;
}

export interface ClosedPosition {
  address: string;
  symbol: string;
  imageUrl: string | null;
  realizedUsd: number;
}

export interface PortfolioActivity {
  side: 'buy' | 'sell';
  symbol: string;
  address: string;
  valueUsd: number | null;
  realizedUsd: number | null;
  at: string;
}

export interface Portfolio {
  kind: 'portfolio';
  /** Absent on cards saved before the sandbox existed: those were live. */
  mode?: TradingMode;
  address: string;
  totalUsd: number;
  unpricedCount: number;
  holdings: Holding[];
  asOf: string;
  /** Sandbox only. Deposits are what profit is measured against. */
  netDepositsUsd?: number;
  totalReturnUsd?: number;
  totalReturnPct?: number | null;
  realizedUsd?: number;
  unrealizedUsd?: number;
  cashUsd?: number;
  investedUsd?: number;
  feesUsd?: number;
  tradeCount?: number;
  startedAt?: string;
  closedPositions?: ClosedPosition[];
  recentTrades?: PortfolioActivity[];
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
  | { id: string; role: 'error'; text: string }
  /** A quiet line in the transcript, e.g. "Switched to Sandbox". */
  | { id: string; role: 'notice'; text: string };
