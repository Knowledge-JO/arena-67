'use client';

import { useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { FlaskConical, RotateCcw, X } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { cn } from '@/lib/utils';

type Asset = 'ETH' | 'USDG';

const PRESETS: Record<Asset, string[]> = {
  USDG: ['100', '1000', '10000'],
  ETH: ['0.1', '1', '5'],
};

/**
 * Add paper ETH or USDG, or start over.
 *
 * Presets first, because most people just want "some money to try this
 * with". Reset is at the bottom and asks twice: it clears the paper account,
 * and nobody should lose a practice history to a stray tap.
 */
export function AddFundsDialog({
  onClose,
  onDone,
}: {
  onClose: () => void;
  /** Called with a short description of what changed. */
  onDone: (note: string) => void;
}) {
  const [asset, setAsset] = useState<Asset>('USDG');
  const [amount, setAmount] = useState('1000');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const valid = /^\d+(\.\d+)?$/.test(amount.trim()) && Number(amount) > 0;

  const add = async () => {
    if (!valid || working) return;
    setWorking(true);
    setError(null);
    try {
      const r = await api.depositPaper(asset, amount.trim());
      onDone(`Added ${Number(amount).toLocaleString()} paper ${asset} (about $${Math.round(r.valueUsd).toLocaleString()}).`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not add funds. Try again.');
    } finally {
      setWorking(false);
    }
  };

  const reset = async () => {
    setWorking(true);
    setError(null);
    try {
      await api.resetSandbox();
      onDone('Sandbox reset — you are starting fresh.');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not reset. Try again.');
    } finally {
      setWorking(false);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 grid place-items-center bg-black/60 px-4"
      onClick={onClose}
    >
      <motion.div
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-funds-title"
        initial={{ y: 12, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm rounded-xl border border-border-strong bg-surface-raised p-5 shadow-2xl"
      >
        <div className="flex items-center justify-between">
          <h2 id="add-funds-title" className="inline-flex items-center gap-2 text-sm font-semibold">
            <FlaskConical size={15} className="text-amber-300" aria-hidden="true" />
            Add paper funds
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="grid h-8 w-8 place-items-center rounded-md text-fg-subtle hover:bg-surface hover:text-fg"
          >
            <X size={14} />
          </button>
        </div>
        <p className="mt-1 text-[12px] leading-snug text-fg-muted">
          Practice money for the sandbox. It trades at real prices but isn’t real, and adding it never counts as profit.
        </p>

        <form
          className="mt-4"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <div role="radiogroup" aria-label="Currency" className="grid grid-cols-2 gap-1.5">
            {(['USDG', 'ETH'] as const).map((a) => (
              <button
                key={a}
                type="button"
                role="radio"
                aria-checked={asset === a}
                onClick={() => {
                  setAsset(a);
                  setAmount(PRESETS[a][1]);
                }}
                className={cn(
                  'min-h-10 rounded-lg border text-sm font-medium transition-colors',
                  asset === a
                    ? 'border-amber-400/50 bg-amber-400/10 text-amber-200'
                    : 'border-border-base text-fg-muted hover:border-border-strong',
                )}
              >
                {a === 'USDG' ? 'USDG (dollars)' : 'ETH'}
              </button>
            ))}
          </div>

          <label className="mt-3 block text-[11px] text-fg-subtle" htmlFor="paper-amount">
            Amount
          </label>
          <div className="mt-1 flex items-center rounded-lg border border-border-base bg-surface focus-within:border-border-strong">
            <input
              id="paper-amount"
              ref={input}
              inputMode="decimal"
              autoComplete="off"
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))}
              className="min-h-11 w-full bg-transparent px-3 text-base tabular-nums outline-none"
            />
            <span className="pr-3 text-sm text-fg-subtle">{asset}</span>
          </div>
          <div className="mt-2 flex gap-1.5">
            {PRESETS[asset].map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setAmount(p)}
                className="min-h-8 flex-1 rounded-md border border-border-base text-xs tabular-nums text-fg-muted hover:border-border-strong hover:text-fg"
              >
                {Number(p).toLocaleString()}
              </button>
            ))}
          </div>

          {error && <p className="mt-3 text-[12px] text-negative">{error}</p>}

          <button
            type="submit"
            disabled={!valid || working}
            className="mt-4 min-h-11 w-full rounded-lg bg-amber-400 text-sm font-semibold text-bg transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            {working && !confirmReset ? 'Adding…' : `Add ${valid ? Number(amount).toLocaleString() : ''} ${asset}`}
          </button>
        </form>

        <div className="mt-4 border-t border-border-base pt-3">
          {confirmReset ? (
            <div className="rounded-lg bg-negative/10 p-3">
              <p className="text-[12px] leading-snug text-fg">
                This clears your paper balances and profit and starts over. Past trades are kept but hidden.
              </p>
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  onClick={() => setConfirmReset(false)}
                  className="min-h-9 flex-1 rounded-md border border-border-strong text-xs font-medium"
                >
                  Keep my account
                </button>
                <button
                  type="button"
                  onClick={() => void reset()}
                  disabled={working}
                  className="min-h-9 flex-1 rounded-md bg-negative text-xs font-semibold text-bg disabled:opacity-50"
                >
                  {working ? 'Resetting…' : 'Reset sandbox'}
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmReset(true)}
              className="inline-flex items-center gap-1.5 text-[12px] text-fg-subtle hover:text-fg"
            >
              <RotateCcw size={12} aria-hidden="true" />
              Start over with an empty sandbox
            </button>
          )}
        </div>
      </motion.div>
    </motion.div>
  );
}
