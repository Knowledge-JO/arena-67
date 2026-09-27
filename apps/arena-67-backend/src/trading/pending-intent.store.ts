import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { TradeIntent } from '../openserv/schemas';
import type { PoolRecord } from '../chain/pool-index.service';
import type { TokenMarket } from '../market/market.types';

export interface TokenCandidate {
  /** Opaque id the client echoes back. The raw address never round-trips. */
  id: string;
  address: `0x${string}`;
  symbol: string;
  name: string;
  decimals: number;
  liquidityUsd: number;
  logoUrl?: string;
  /** Surfaced verbatim in the picker so users can spot obvious traps. */
  warnings: string[];
}

export interface Quote {
  id: string;
  amountIn: bigint;
  amountOut: bigint;
  /** amountOut after MAX_SLIPPAGE_BPS; what actually goes on-chain. */
  minAmountOut: bigint;
  priceImpactBps: number;
  feeTier: number;
  tickSpacing: number;
  hooks: `0x${string}`;
  /** The venue this price came from; the swap must use this exact pool. */
  poolId: string;
  quotedAt: number;
}

export type IntentStatus =
  | 'collecting'
  | 'quoted'
  | 'executing'
  | 'executed'
  | 'failed'
  | 'expired';

export interface PendingIntent {
  id: string;
  sessionId: string;
  /**
   * The mode this trade started in, fixed for its life. Confirm refuses a
   * trade whose mode no longer matches the user's, so a paper trade can never
   * be carried into a signature by flipping the switch.
   */
  mode: 'sandbox' | 'live';
  status: IntentStatus;
  action: 'buy' | 'sell';
  ticker?: string;
  amount?: number;
  /** Size as a share (1–100) of the balance being spent; exclusive with amount. */
  percent?: number;
  currency?: string;
  candidates?: TokenCandidate[];
  token?: TokenCandidate;
  /** The asset the quote was priced in; re-deriving it at confirm could differ. */
  funding?: { address: `0x${string}`; symbol: string; decimals: number };
  /** Venue chosen on the token page, if any. Pinned through to the swap. */
  pool?: PoolRecord;
  /** Market view backing the token page, cached for the session. */
  market?: TokenMarket;
  quote?: Quote;
  /** The token's own transfer tax, measured at quote time. Null: unknown. */
  transferTax?: import('../chain/transfer-tax.service').TransferTax | null;
  txHash?: `0x${string}`;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

/** Quotes go stale fast on memecoin liquidity. */
const QUOTE_TTL_MS = 30_000;
const INTENT_TTL_MS = 15 * 60_000;

/**
 * Holds every in-flight trade server-side, keyed by session.
 *
 * This exists to close a hole in the original design, where the half-built
 * trade was handed to the browser and sent back as a chat message
 * ("proceed, the contract address is 0x..."). That let a client return a
 * different address or amount than the one the agent actually extracted, and
 * the backend would have signed it. Here the client only ever echoes opaque
 * ids; amounts and addresses are re-read from this store at execution time.
 *
 * In-memory on purpose — a hackathon build does not need Redis, and an intent
 * that dies with the process is the safe failure direction.
 */
@Injectable()
export class PendingIntentStore {
  private readonly log = new Logger(PendingIntentStore.name);
  private readonly intents = new Map<string, PendingIntent>();

  create(sessionId: string, intent: TradeIntent, mode: 'sandbox' | 'live' = 'sandbox'): PendingIntent {
    const now = Date.now();
    const pending: PendingIntent = {
      id: randomUUID(),
      sessionId,
      mode,
      status: 'collecting',
      action: intent.action,
      ticker: intent.ticker,
      amount: intent.amount,
      percent: intent.percent,
      currency: intent.currency,
      createdAt: now,
      updatedAt: now,
    };
    this.intents.set(pending.id, pending);
    return pending;
  }

  /**
   * Always fetch through this. It enforces session ownership, so one session
   * can never advance or execute another session's intent by guessing an id.
   */
  get(intentId: string, sessionId: string): PendingIntent {
    const intent = this.intents.get(intentId);
    if (!intent) throw new Error('This trade is no longer available.');
    if (intent.sessionId !== sessionId) {
      this.log.warn(`Session ${sessionId} tried to read intent ${intentId}`);
      throw new Error('This trade is no longer available.');
    }
    if (Date.now() - intent.createdAt > INTENT_TTL_MS) {
      intent.status = 'expired';
      throw new Error('This trade expired. Start again.');
    }
    return intent;
  }

  patch(
    intentId: string,
    sessionId: string,
    patch: Partial<Omit<PendingIntent, 'id' | 'sessionId' | 'createdAt'>>,
  ): PendingIntent {
    const intent = this.get(intentId, sessionId);
    Object.assign(intent, patch, { updatedAt: Date.now() });
    return intent;
  }

  /** Resolve a picked candidate by id — the client never supplies an address. */
  selectCandidate(
    intentId: string,
    sessionId: string,
    candidateId: string,
  ): PendingIntent {
    const intent = this.get(intentId, sessionId);
    const token = intent.candidates?.find((c) => c.id === candidateId);
    if (!token) throw new Error('That token is not one of the options.');
    return this.patch(intentId, sessionId, { token, candidates: undefined });
  }

  /**
   * Claims the intent for execution. Returns false if it was already claimed,
   * which makes a duplicated confirm (double-click, socket retry) a no-op
   * rather than a second on-chain swap.
   */
  claimForExecution(
    intentId: string,
    sessionId: string,
    quoteId: string,
  ): boolean {
    const intent = this.get(intentId, sessionId);
    if (intent.status !== 'quoted') return false;
    if (!intent.quote || intent.quote.id !== quoteId) {
      throw new Error('That price is out of date. Here is a fresh quote.');
    }
    if (Date.now() - intent.quote.quotedAt > QUOTE_TTL_MS) {
      throw new Error('That price is out of date. Here is a fresh quote.');
    }
    intent.status = 'executing';
    intent.updatedAt = Date.now();
    return true;
  }

  /** Most recent still-collecting intent, so follow-up chat turns attach to it. */
  activeFor(sessionId: string): PendingIntent | undefined {
    let best: PendingIntent | undefined;
    for (const intent of this.intents.values()) {
      if (intent.sessionId !== sessionId) continue;
      if (intent.status !== 'collecting' && intent.status !== 'quoted') continue;
      if (Date.now() - intent.createdAt > INTENT_TTL_MS) continue;
      if (!best || intent.updatedAt > best.updatedAt) best = intent;
    }
    return best;
  }

  sweep(): void {
    const now = Date.now();
    for (const [id, intent] of this.intents) {
      if (now - intent.createdAt > INTENT_TTL_MS && intent.status !== 'executing') {
        this.intents.delete(id);
      }
    }
  }
}

export { QUOTE_TTL_MS, INTENT_TTL_MS };
