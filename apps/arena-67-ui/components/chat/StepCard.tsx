'use client';

import { motion } from 'motion/react';
import { ArrowUpRight, AlertCircle } from 'lucide-react';
import { TokenPicker } from './TokenPicker';
import { ConfirmCard } from './ConfirmCard';
import { TokenPage } from './TokenPage';
import { TokenChoices } from './TokenChoices';
import { PortfolioCard } from '../account/PortfolioCard';
import { TokenReportCard } from '../research/TokenReportCard';
import { TopTokensCard } from '../research/TopTokensCard';
import { HolderOverlapCard } from '../research/HolderOverlapCard';
import { WalletHoldingsCard } from '../research/WalletHoldingsCard';
import type { TradeStep } from '@/lib/types';

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
  onConfirm,
  onRequote,
  onPickToken,
  onAsk,
  onBuy,
  busy,
  spent,
  repricing,
  bare,
}: {
  step: TradeStep;
  onSelectToken: (intentId: string, candidateId: string) => void;
  onSelectPool: (intentId: string, poolId: string) => void;
  onSubmitAmount: (intentId: string, amount: number) => void;
  onConfirm: (intentId: string, quoteId: string) => void;
  onRequote: (intentId: string) => void;
  /** Picking a research result opens that token; no pending trade is involved. */
  onPickToken: (address: string, symbol: string) => void;
  /** Sends a message to the agent, as if typed — for a card's follow-up questions. */
  onAsk: (text: string) => void;
  /** Starts a buy for this token through the usual trade flow. */
  onBuy: (address: string, symbol: string) => void;
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

          {step.kind === 'portfolio' && <PortfolioCard portfolio={step} />}

          {step.kind === 'token_report' && (
            <TokenReportCard report={step} onBuy={onBuy} onAsk={onAsk} disabled={busy} />
          )}

          {step.kind === 'top_tokens' && (
            <TopTokensCard data={step} onPickToken={onPickToken} onAsk={onAsk} disabled={busy} />
          )}

          {step.kind === 'holder_overlap' && (
            <HolderOverlapCard data={step} onAsk={onAsk} disabled={busy} />
          )}

          {step.kind === 'wallet_holdings' && (
            <WalletHoldingsCard data={step} onPickToken={onPickToken} disabled={busy} />
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
              degraded={step.degraded}
              busy={busy}
              spent={spent}
              onSelectPool={(poolId) => onSelectPool(step.intentId, poolId)}
              onSubmitAmount={(amount) => onSubmitAmount(step.intentId, amount)}
            />
          )}

          {step.kind === 'confirm' && (
            <ConfirmCard
              summary={step.summary}
              disabled={busy}
              spent={spent}
              repricing={repricing}
              onConfirm={() => onConfirm(step.intentId, step.quoteId)}
              onRequote={() => onRequote(step.intentId)}
            />
          )}

          {step.kind === 'executed' && (
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
