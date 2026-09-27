'use client';

import { useCallback, useEffect, useState } from 'react';
import { Check, Copy, FlaskConical, Wallet } from 'lucide-react';
import { api } from '@/lib/api';
import { cn, shortAddress } from '@/lib/utils';
import { usdExact } from '@/lib/format';
import type { TradingMode } from '@/lib/types';

const POLL_MS = 20_000;

/**
 * The balance chip in the chat header.
 *
 * Shows ETH specifically, not a USD total, because ETH is what pays gas: a
 * wallet can hold thousands in tokens and still be unable to trade with none
 * of it. Clicking it asks the agent for the full portfolio in the current
 * conversation, rather than opening a separate screen — the answer becomes
 * part of the chat, where it can be referred back to.
 */
export function WalletBox({
  onOpenPortfolio,
  disabled,
  mode = 'live',
  refreshKey = 0,
}: {
  onOpenPortfolio: () => void;
  disabled?: boolean;
  /** In sandbox the box shows the paper account's value instead of real ETH. */
  mode?: TradingMode;
  refreshKey?: number;
}) {
  const [bal, setBal] = useState<{ address: string; eth: string } | null>(null);
  const [paperUsd, setPaperUsd] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      if (mode === 'sandbox') setPaperUsd((await api.sandbox()).totalUsd);
      else setBal(await api.balance());
    } catch {
      /* keep showing the last good value */
    }
  }, [mode]);

  useEffect(() => {
    // First load on the next tick, then on the interval.
    const first = setTimeout(load, 0);
    const t = setInterval(load, POLL_MS);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [load, refreshKey]);

  if (mode === 'sandbox') {
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={onOpenPortfolio}
        title="Your paper portfolio"
        className={cn(
          'inline-flex items-center gap-1.5 rounded-lg border px-2 py-1.5 text-xs font-medium tabular-nums transition-colors sm:px-2.5',
          'border-amber-400/30 bg-amber-400/[0.07] text-amber-100 hover:bg-amber-400/15',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60',
          'disabled:cursor-not-allowed disabled:opacity-50',
        )}
      >
        {/* The sandbox strip right below says "Sandbox"; phones need the room. */}
        <FlaskConical size={13} className="hidden text-amber-300 sm:block" />
        {paperUsd === null ? '—' : usdExact(paperUsd)}
        <span className="sr-only">paper balance</span>
      </button>
    );
  }

  const eth = bal ? Number(bal.eth) : null;
  const lowGas = eth !== null && eth < 0.0005;

  return (
    <div className="flex items-center gap-1">
      {bal && (
        <button
          type="button"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(bal.address);
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            } catch {
              /* clipboard blocked */
            }
          }}
          title="Your deposit address — copy"
          className="hidden items-center gap-1 rounded-md px-1.5 py-1 font-mono text-[10px] text-fg-subtle transition-colors hover:bg-surface-raised hover:text-fg sm:inline-flex"
        >
          {shortAddress(bal.address)}
          {copied ? <Check size={10} className="text-positive" /> : <Copy size={10} />}
        </button>
      )}

      <button
        type="button"
        disabled={disabled || !bal}
        onClick={onOpenPortfolio}
        title="Show my portfolio"
        className={cn(
          'inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium tabular-nums transition-colors',
          'border-border-base bg-surface hover:border-border-strong hover:bg-surface-raised',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60',
          'disabled:cursor-not-allowed disabled:opacity-50',
        )}
      >
        <Wallet size={13} className={lowGas ? 'text-warning' : 'text-fg-muted'} />
        {eth === null ? '—' : `${eth < 0.0001 && eth > 0 ? '<0.0001' : eth.toFixed(4)} ETH`}
      </button>
    </div>
  );
}
