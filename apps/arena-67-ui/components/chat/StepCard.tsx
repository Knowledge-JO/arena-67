'use client';

import { motion } from 'motion/react';
import { ArrowUpRight, AlertCircle } from 'lucide-react';
import { TokenPicker } from './TokenPicker';
import { ConfirmCard } from './ConfirmCard';
import type { TradeStep } from '@/lib/types';

/**
 * Renders one reply from the desk. Every trade step lands in the transcript as
 * a card rather than a modal, so scrolling back shows exactly what was agreed
 * to and what it cost.
 */
export function StepCard({
  step,
  onSelectToken,
  onConfirm,
  busy,
  spent,
}: {
  step: TradeStep;
  onSelectToken: (intentId: string, candidateId: string) => void;
  onConfirm: (intentId: string, quoteId: string) => void;
  busy?: boolean;
  spent?: boolean;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22, ease: 'easeOut' }}
      className="max-w-[46rem]"
    >
      <div className="flex gap-3">
        <div className="mt-1 h-6 w-6 shrink-0 rounded-md bg-accent/15 text-center text-[10px] font-semibold leading-6 text-accent">
          67
        </div>

        <div className="min-w-0 flex-1">
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

          {step.kind === 'choose_token' && (
            <TokenPicker
              candidates={step.candidates}
              disabled={busy || spent}
              onSelect={(candidateId) => onSelectToken(step.intentId, candidateId)}
            />
          )}

          {step.kind === 'confirm' && (
            <ConfirmCard
              summary={step.summary}
              disabled={busy}
              spent={spent}
              onConfirm={() => onConfirm(step.intentId, step.quoteId)}
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
