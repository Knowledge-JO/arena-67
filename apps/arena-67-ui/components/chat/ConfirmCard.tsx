'use client';

import { motion } from 'motion/react';
import { useEffect, useState } from 'react';
import { FlaskConical, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';

/** Matches QUOTE_TTL_MS in the backend's pending-intent.store.ts. */
const QUOTE_TTL_MS = 30_000;

/**
 * The gate between a priced trade and a signed one.
 *
 * The original plan had no such gate — it went from "intent validated" to
 * "broadcast". Everything here exists to make the moment of consent specific:
 * you confirm *this* quote, and the ring shows it going stale.
 *
 * "Guaranteed minimum" is the honest headline number. It is the slippage floor
 * the swap actually enforces on-chain, where the expected fill is only an
 * estimate. Price impact is deliberately absent: the backend does not compute
 * it yet, and a plausible-looking zero would be worse than no figure at all.
 */
export function ConfirmCard({
  summary,
  onConfirm,
  onRequote,
  disabled,
  spent,
  repricing,
  mode = 'live',
}: {
  summary: Record<string, string>;
  /** Sandbox cards say "paper" everywhere a real one says "sign". */
  mode?: 'sandbox' | 'live';
  onConfirm: () => void;
  /** Fetches a fresh price for the same venue. */
  onRequote: () => void;
  disabled?: boolean;
  spent?: boolean;
  repricing?: boolean;
}) {
  const [remaining, setRemaining] = useState(QUOTE_TTL_MS);

  useEffect(() => {
    if (spent) return;
    const started = Date.now();
    const t = setInterval(() => {
      const left = Math.max(0, QUOTE_TTL_MS - (Date.now() - started));
      setRemaining(left);
      if (left === 0) clearInterval(t);
    }, 100);
    return () => clearInterval(t);
  }, [spent]);

  const pct = remaining / QUOTE_TTL_MS;
  const stale = remaining === 0;
  const seconds = Math.ceil(remaining / 1000);

  const order = [
    'action',
    'token',
    'contract',
    'venue',
    'spend',
    'receive',
    'guaranteedMinimum',
    'poolFee',
    'networkFee',
    'transferTax',
    'paperNote',
  ];
  const label: Record<string, string> = {
    guaranteedMinimum: 'guaranteed minimum',
    poolFee: 'pool fee',
    networkFee: 'network fee',
    transferTax: 'transfer tax',
    paperNote: 'note',
  };
  /** Sentences, not figures: these wrap rather than cut off. */
  const prose = new Set(['networkFee', 'transferTax', 'paperNote']);
  const taxed = /\d+(\.\d+)?% on buys/.test(summary.transferTax ?? '');
  const rows = order.filter((k) => k in summary);

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22, ease: 'easeOut' }}
      className={cn(
        'mt-3 overflow-hidden rounded-xl border bg-surface-raised',
        mode === 'sandbox' ? 'border-amber-400/30' : 'border-border-base',
      )}
    >
      {mode === 'sandbox' && (
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 border-b border-amber-400/20 bg-amber-400/[0.07] px-3.5 py-2 text-[11px] text-amber-200">
          <FlaskConical size={12} aria-hidden="true" />
          <span className="whitespace-nowrap font-semibold">Paper trade</span>
          <span className="text-amber-200/70">· real mainnet price, no real funds move</span>
        </div>
      )}
      <dl className="divide-y divide-border-base/70">
        {rows.map((k) => (
          <div key={k} className="flex items-baseline gap-3 px-3.5 py-2.5">
            <dt className="w-36 shrink-0 text-xs text-fg-subtle">
              {label[k] ?? k}
            </dt>
            <dd
              className={cn(
                'min-w-0 flex-1 text-sm',
                prose.has(k) ? 'text-[13px] leading-snug text-fg-muted' : 'truncate',
                k === 'contract' && 'font-mono text-[11px] text-fg-muted',
                k === 'guaranteedMinimum' && 'font-medium text-positive',
                k === 'transferTax' && taxed && 'font-medium text-amber-300',
              )}
            >
              {summary[k]}
            </dd>
          </div>
        ))}
      </dl>

      <div className="flex items-center gap-3 border-t border-border-base px-3.5 py-3">
        {!spent && (
          <div className="flex items-center gap-2">
            <svg width="18" height="18" viewBox="0 0 20 20" className="-rotate-90">
              <circle
                cx="10" cy="10" r="8" fill="none"
                stroke="var(--border-strong)" strokeWidth="2"
              />
              <circle
                cx="10" cy="10" r="8" fill="none"
                stroke={stale ? 'var(--negative)' : 'var(--accent)'}
                strokeWidth="2" strokeLinecap="round"
                strokeDasharray={2 * Math.PI * 8}
                strokeDashoffset={2 * Math.PI * 8 * (1 - pct)}
              />
            </svg>
            <span
              className={cn(
                'tabular-nums text-xs',
                stale ? 'text-negative' : 'text-fg-subtle',
              )}
            >
              {stale ? 'price expired' : `${seconds}s`}
            </span>
          </div>
        )}

        {/*
          An expired quote is recoverable, not a dead end. The numbers above
          stay on screen while re-pricing so the card keeps its height and the
          user can see what changed.
        */}
        {stale && !spent ? (
          <button
            type="button"
            onClick={onRequote}
            disabled={disabled || repricing}
            className={cn(
              'ml-auto inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium transition-colors',
              'border border-border-strong text-fg hover:bg-surface',
              'disabled:cursor-not-allowed disabled:opacity-50',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60',
            )}
          >
            <RefreshCw size={13} className={repricing ? 'animate-spin' : undefined} />
            {repricing ? 'Re-pricing…' : 'Get fresh quote'}
          </button>
        ) : (
          <button
            type="button"
            onClick={onConfirm}
            disabled={disabled || spent}
            className={cn(
              'ml-auto rounded-lg px-4 py-2 text-sm font-medium transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60',
              mode === 'sandbox' ? 'bg-amber-400 text-bg hover:opacity-90' : 'bg-accent text-accent-fg hover:opacity-90',
              'disabled:cursor-not-allowed disabled:opacity-40',
            )}
          >
            {spent
              ? mode === 'sandbox' ? 'Placed' : 'Confirmed'
              : mode === 'sandbox' ? 'Place paper trade' : 'Confirm & sign'}
          </button>
        )}
      </div>
    </motion.div>
  );
}
