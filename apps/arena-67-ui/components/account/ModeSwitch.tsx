'use client';

import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { FlaskConical, Zap } from 'lucide-react';
import { cn, shortAddress } from '@/lib/utils';
import type { TradingMode } from '@/lib/types';

/**
 * Sandbox | Live.
 *
 * Going to Sandbox is instant — it can only make things safer. Going to Live
 * asks first, in plain words, because from then on a confirmed trade spends
 * real money. The switch lives on the server; this only asks it to change.
 */
export function ModeSwitch({
  mode,
  walletAddress,
  onChange,
  disabled,
}: {
  mode: TradingMode;
  walletAddress: string;
  onChange: (mode: TradingMode) => Promise<void>;
  disabled?: boolean;
}) {
  const [asking, setAsking] = useState(false);
  const [working, setWorking] = useState(false);

  const change = async (next: TradingMode) => {
    if (next === mode || working) return;
    if (next === 'live') {
      setAsking(true);
      return;
    }
    setWorking(true);
    try {
      await onChange(next);
    } finally {
      setWorking(false);
    }
  };

  const goLive = async () => {
    setWorking(true);
    try {
      await onChange('live');
      setAsking(false);
    } finally {
      setWorking(false);
    }
  };

  return (
    <>
      <div
        role="radiogroup"
        aria-label="Trading mode"
        className="inline-flex items-center rounded-lg border border-border-base bg-surface p-0.5"
      >
        {(
          [
            ['sandbox', 'Sandbox', FlaskConical],
            ['live', 'Live', Zap],
          ] as const
        ).map(([value, label, Icon]) => {
          const active = mode === value;
          return (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={disabled || working}
              onClick={() => void change(value)}
              title={
                value === 'sandbox'
                  ? 'Paper money at real mainnet prices'
                  : 'Real money from your own wallet'
              }
              className={cn(
                'relative inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-medium transition-colors sm:px-2',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 disabled:opacity-50',
                active
                  ? value === 'sandbox'
                    ? 'bg-amber-400/15 text-amber-300'
                    : 'bg-positive/15 text-positive'
                  : 'text-fg-subtle hover:text-fg',
              )}
            >
              <Icon size={11} aria-hidden="true" />
              {label}
            </button>
          );
        })}
      </div>

      <AnimatePresence>
        {asking && (
          <GoLiveDialog
            walletAddress={walletAddress}
            working={working}
            onCancel={() => setAsking(false)}
            onConfirm={() => void goLive()}
          />
        )}
      </AnimatePresence>
    </>
  );
}

function GoLiveDialog({
  walletAddress,
  working,
  onCancel,
  onConfirm,
}: {
  walletAddress: string;
  working: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const stay = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    // Focus lands on the safe choice.
    stay.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onCancel();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 grid place-items-center bg-black/60 px-4"
      onClick={onCancel}
    >
      <motion.div
        role="dialog"
        aria-modal="true"
        aria-labelledby="go-live-title"
        initial={{ y: 12, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: 12, opacity: 0 }}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm rounded-xl border border-border-strong bg-surface-raised p-5 shadow-2xl"
      >
        <div className="flex items-center gap-2 text-positive">
          <Zap size={16} aria-hidden="true" />
          <h2 id="go-live-title" className="text-sm font-semibold text-fg">
            Switch to Live trading?
          </h2>
        </div>
        <ul className="mt-3 space-y-1.5 text-[13px] leading-snug text-fg-muted">
          <li>Trades will spend <span className="font-medium text-fg">real money</span> from your wallet{' '}
            <code className="font-mono text-[11px]">{shortAddress(walletAddress)}</code>.</li>
          <li>Nothing is ever sent until you confirm a quote.</li>
          <li>Your paper account stays exactly as it is — switch back any time.</li>
        </ul>
        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button
            ref={stay}
            type="button"
            onClick={onCancel}
            className="min-h-10 rounded-lg border border-border-strong px-4 text-sm font-medium hover:bg-surface"
          >
            Stay in Sandbox
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={working}
            className="min-h-10 rounded-lg bg-positive px-4 text-sm font-semibold text-bg hover:opacity-90 disabled:opacity-50"
          >
            {working ? 'Switching…' : 'Use real money'}
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}
