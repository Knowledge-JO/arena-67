'use client';

import { motion } from 'motion/react';
import { ArrowUpRight, AlertCircle, FlaskConical } from 'lucide-react';
import { usdExact, usdSigned, changeTone } from '@/lib/format';
import { cn } from '@/lib/utils';
import { TokenPicker } from './TokenPicker';
import { ConfirmCard } from './ConfirmCard';
import { TokenPage } from './TokenPage';
import { TokenChoices } from './TokenChoices';
import { PortfolioCard } from '../account/PortfolioCard';
import { TokenReportCard } from '../research/TokenReportCard';
import { TopTokensCard } from '../research/TopTokensCard';
import { NewTokensCard } from '../research/NewTokensCard';
import { HolderOverlapCard } from '../research/HolderOverlapCard';
import { WalletHoldingsCard } from '../research/WalletHoldingsCard';
import type { TradeStep } from '@/lib/types';

/**
 * Cards that are the whole answer: the agent's text goes inside them as a
 * note, not above them. Trade steps keep their text outside — there it is an
 * instruction ("pick a pool"), not commentary on the card. The portfolio card
 * drops the text altogether: it updates live, and a comment written once goes
 * stale ("ready to sell U?" after U is sold).
 */
export const CARD_OWNS_NOTE = new Set([
  'portfolio',
  'token_report',
  'top_tokens',
  'new_tokens',
  'holder_overlap',
  'wallet_holdings',
]);

/**
 * Renders one reply from the desk. Every trade step lands in the transcript as
 * a card rather than a modal, so scrolling back shows exactly what was agreed
 * to and what it cost.
 */
export function StepCard({
  step,
  onSelectToken,
  onSelectPool,
  onSubmitAmount,
  onSubmitPercent,
  onConfirm,
  onRequote,
  onPickToken,
  onAsk,
  onBuy,
  onSell,
  onAddFunds,
  live,
  note,
  busy,
  spent,
  repricing,
  bare,
}: {
  step: TradeStep;
  onSelectToken: (intentId: string, candidateId: string) => void;
  onSelectPool: (intentId: string, poolId: string) => void;
  onSubmitAmount: (intentId: string, amount: number) => void;
  /** A share of what is held — "sell 100%" — sized exactly by the backend. */
  onSubmitPercent: (intentId: string, percent: number) => void;
  onConfirm: (intentId: string, quoteId: string) => void;
  onRequote: (intentId: string) => void;
  /** Picking a research result opens that token; no pending trade is involved. */
  onPickToken: (address: string, symbol: string) => void;
  /** Sends a message to the agent, as if typed — for a card's follow-up questions. */
  onAsk: (text: string) => void;
  /** Starts a buy for this token through the usual trade flow. */
  onBuy: (address: string, symbol: string) => void;
  /** Starts a sell for an open portfolio position through the usual trade flow. */
  onSell: (address: string, symbol: string) => void;
  /** Opens the add-funds dialog, from an empty paper portfolio. */
  onAddFunds?: () => void;
  /** The agent's comment, drawn inside cards that carry one (see CARD_OWNS_NOTE). */
  note?: string;
  /** For report cards: keep market figures updating (the latest two only). */
  live?: boolean;
  busy?: boolean;
  spent?: boolean;
  repricing?: boolean;
  /**
   * Drop the avatar and message line. Set when the card sits inside an agent
   * reply, which already shows both — repeating them reads as the desk
   * speaking twice.
   */
  bare?: boolean;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22, ease: 'easeOut' }}
      className={bare ? undefined : 'max-w-[46rem]'}
    >
      <div className={bare ? undefined : 'flex gap-3'}>
        {!bare && (
          <div className="mt-1 h-6 w-6 shrink-0 rounded-md bg-accent/15 text-center text-[10px] font-semibold leading-6 text-accent">
            67
          </div>
        )}

        <div className="min-w-0 flex-1">
          {!bare && 'message' in step && (
          <p
            className={
              step.kind === 'rejected'
                ? 'flex items-start gap-1.5 text-sm leading-relaxed text-negative'
                : 'text-sm leading-relaxed text-fg'
            }
          >
            {step.kind === 'rejected' && (
              <AlertCircle size={14} className="mt-0.5 shrink-0" />
            )}
            <span>{step.message}</span>
          </p>
          )}

          {step.kind === 'choose_token' && (
            <TokenPicker
              candidates={step.candidates}
              disabled={busy || spent}
              onSelect={(candidateId) => onSelectToken(step.intentId, candidateId)}
            />
          )}

          {step.kind === 'portfolio' && <PortfolioCard
              portfolio={step}
              live={live}
               onAddFunds={onAddFunds}
               onPickToken={onPickToken}
               onSell={onSell}
               disabled={busy}
            />}

          {step.kind === 'token_report' && (
            <TokenReportCard report={step} onBuy={onBuy} onAsk={onAsk} disabled={busy} live={live} note={note} />
          )}

          {step.kind === 'top_tokens' && (
            <TopTokensCard data={step} onPickToken={onPickToken} onAsk={onAsk} disabled={busy} note={note} />
          )}

          {step.kind === 'new_tokens' && (
            <NewTokensCard data={step} onPickToken={onPickToken} disabled={busy} note={note} />
          )}

          {step.kind === 'holder_overlap' && (
            <HolderOverlapCard data={step} onAsk={onAsk} disabled={busy} note={note} />
          )}

          {step.kind === 'wallet_holdings' && (
            <WalletHoldingsCard data={step} onPickToken={onPickToken} disabled={busy} note={note} />
          )}

          {step.kind === 'token_choices' && (
            <TokenChoices
              candidates={step.candidates}
              disabled={busy}
              onPick={onPickToken}
            />
          )}

          {step.kind === 'token_detail' && (
            <TokenPage
              token={step.token}
              stats={step.stats}
              pools={step.pools}
              selectedPoolId={step.selectedPoolId}
              action={step.action}
              available={step.available ?? null}
              degraded={step.degraded}
              busy={busy}
              spent={spent}
              onSelectPool={(poolId) => onSelectPool(step.intentId, poolId)}
              onSubmitAmount={(amount) => onSubmitAmount(step.intentId, amount)}
              onSubmitPercent={(pct) => onSubmitPercent(step.intentId, pct)}
            />
          )}

          {step.kind === 'confirm' && (
            <ConfirmCard
              mode={step.mode ?? 'live'}
              summary={step.summary}
              disabled={busy}
              spent={spent}
              repricing={repricing}
              onConfirm={() => onConfirm(step.intentId, step.quoteId)}
              onRequote={() => onRequote(step.intentId)}
            />
          )}

          {step.kind === 'executed' && step.mode === 'sandbox' && step.paper && (
            <div className="mt-3 overflow-hidden rounded-xl border border-amber-400/30 bg-surface-raised">
              <div className="flex items-center gap-1.5 border-b border-amber-400/20 bg-amber-400/[0.07] px-3.5 py-2 text-[11px] text-amber-200">
                <FlaskConical size={12} aria-hidden="true" />
                <span className="font-semibold">Paper trade filled</span>
              </div>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2 px-3.5 py-3 text-xs sm:grid-cols-4">
                <div>
                  <dt className="text-fg-subtle">Spent</dt>
                  <dd className="mt-0.5 truncate tabular-nums">{step.paper.spent}</dd>
                </div>
                <div>
                  <dt className="text-fg-subtle">Received</dt>
                  <dd className="mt-0.5 truncate tabular-nums">{step.paper.received}</dd>
                </div>
                <div>
                  <dt className="text-fg-subtle">Value</dt>
                  <dd className="mt-0.5 tabular-nums">{usdExact(step.paper.valueUsd)}</dd>
                </div>
                <div>
                  <dt className="text-fg-subtle">{step.paper.realizedUsd != null ? 'Profit on this sale' : 'Network fee'}</dt>
                  <dd className={cn('mt-0.5 tabular-nums', step.paper.realizedUsd != null && changeTone(step.paper.realizedUsd))}>
                    {step.paper.realizedUsd != null
                      ? usdSigned(step.paper.realizedUsd)
                      : `${usdExact(step.paper.feeUsd)} in ${step.paper.feeAsset}`}
                  </dd>
                </div>
              </dl>
              {step.paper.feeAsset !== 'ETH' && (
                <p className="border-t border-border-base px-3.5 py-2 text-[10px] text-fg-subtle">
                  The network fee came from your paper {step.paper.feeAsset}. On mainnet you would need a little ETH for fees.
                </p>
              )}
            </div>
          )}

          {step.kind === 'executed' && step.mode !== 'sandbox' && step.explorerUrl && (
            <a
              href={step.explorerUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2.5 inline-flex items-center gap-1.5 rounded-lg border border-positive/30 bg-positive/10 px-3 py-1.5 text-xs font-medium text-positive transition-colors hover:bg-positive/15"
            >
              View on explorer
              <ArrowUpRight size={12} />
            </a>
          )}
        </div>
      </div>
    </motion.div>
  );
}
