'use client';

import { useState } from 'react';
import { motion } from 'motion/react';
import { Check, Copy } from 'lucide-react';
import { usd, usdCompact } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { Portfolio } from '@/lib/types';

/**
 * A snapshot of the wallet, as it was when asked for.
 *
 * It lives in the conversation where it was requested and does not update:
 * "as of" is stated because a portfolio card scrolled back to an hour later
 * is a record of that moment, not the current state. Asking again produces a
 * new card.
 */
export function PortfolioCard({ portfolio }: { portfolio: Portfolio }) {
  const [copied, setCopied] = useState(false);
  const empty = portfolio.holdings.length === 0;

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="mt-3 overflow-hidden rounded-xl border border-border-base bg-surface-raised"
    >
      <div className="flex items-baseline justify-between gap-3 px-3.5 pb-2 pt-3">
        <div>
          <p className="text-[10px] uppercase tracking-wide text-fg-subtle">Portfolio value</p>
          <p className="mt-0.5 text-lg font-semibold tabular-nums">{usd(portfolio.totalUsd)}</p>
        </div>
        <p className="text-[10px] text-fg-subtle">
          as of {new Date(portfolio.asOf).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </p>
      </div>

      {portfolio.unpricedCount > 0 && (
        <p className="px-3.5 pb-2 text-[11px] text-warning">
          {portfolio.unpricedCount} holding{portfolio.unpricedCount === 1 ? ' has' : 's have'} no
          market price and {portfolio.unpricedCount === 1 ? 'is' : 'are'} not counted in the total.
        </p>
      )}

      {empty ? (
        <div className="border-t border-border-base px-3.5 py-4">
          <p className="text-sm">This wallet is empty.</p>
          <p className="mt-1 text-xs text-fg-muted">
            Send ETH (for gas) and tokens to your deposit address to start trading.
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-border-base/70 border-t border-border-base">
          {portfolio.holdings.map((h) => (
            <li key={h.address} className="flex items-center gap-3 px-3.5 py-2.5">
              {h.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={h.imageUrl} alt="" className="h-7 w-7 shrink-0 rounded-full bg-border-base object-cover" />
              ) : (
                <div className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-border-base text-[9px] font-semibold text-fg-muted">
                  {h.symbol.slice(0, 3).toUpperCase()}
                </div>
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{h.symbol}</p>
                <p className="truncate text-[11px] tabular-nums text-fg-muted">
                  {Number(h.balance).toLocaleString(undefined, { maximumFractionDigits: 6 })}
                </p>
              </div>
              <div className="shrink-0 text-right">
                <p className={cn('text-sm tabular-nums', h.valueUsd == null && 'text-fg-subtle')}>
                  {h.valueUsd == null ? 'unpriced' : usdCompact(h.valueUsd)}
                </p>
                {h.priceUsd != null && (
                  <p className="text-[10px] tabular-nums text-fg-subtle">{usd(h.priceUsd)}</p>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-center gap-2 border-t border-border-base px-3.5 py-2.5">
        <span className="text-[10px] uppercase tracking-wide text-fg-subtle">Deposit</span>
        <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-fg-muted">
          {portfolio.address}
        </code>
        <button
          type="button"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(portfolio.address);
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            } catch {
              /* clipboard blocked; the address is selectable */
            }
          }}
          aria-label="Copy deposit address"
          className="shrink-0 rounded p-1 text-fg-subtle hover:bg-border-base hover:text-fg"
        >
          {copied ? <Check size={12} className="text-positive" /> : <Copy size={12} />}
        </button>
      </div>
    </motion.div>
  );
}
