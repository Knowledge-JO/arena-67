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

export type TradeStep =
  | { kind: 'need_token'; intentId: string; ticker?: string; message: string }
  | {
      kind: 'choose_token';
      intentId: string;
      message: string;
      candidates: TokenCandidate[];
    }
  | { kind: 'need_amount'; intentId: string; symbol: string; message: string }
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
  poolCount: number;
}

export interface TrendingSnapshot {
  index: { ready: boolean; pools: number; tokens: number; hydrated: number; lastBlock: string };
  tokens: TrendingToken[];
  lastRefresh: number;
  stale: boolean;
  error: string | null;
}

/** A turn in the transcript: what the user said, or what the desk replied. */
export type Entry =
  | { id: string; role: 'user'; text: string }
  | { id: string; role: 'agent'; step: TradeStep }
  | { id: string; role: 'error'; text: string };
