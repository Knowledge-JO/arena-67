'use client';

import { motion } from 'motion/react';
import { ChevronRight, Users } from 'lucide-react';
import { cn, shortAddress } from '@/lib/utils';
import { usdCompact, percent, changeTone } from '@/lib/format';
import type { TopTokens } from '@/lib/types';
import { TokenAvatar, asOf } from './shared';
import { CardNote } from '../chat/CardNote';

const WINDOW_LABEL = { h1: 'last hour', h6: 'last 6 hours', h24: 'last 24 hours' } as const;

/**
 * "What is trading the most", as a list you can act on.
 *
 * Every row opens that token's full report. The button underneath asks the
 * obvious next question — who is holding several of these — so nobody has to
 * know how to phrase it.
 */
export function TopTokensCard({
  data,
  onPickToken,
  onAsk,
  disabled,
  note,
}: {
  /** The agent's comment, shown inside the card. */
  note?: string;
  data: TopTokens;
  onPickToken: (address: string, symbol: string) => void;
  onAsk: (text: string) => void;
  disabled?: boolean;
}) {
  const w = data.window;
  const symbols = data.tokens.map((t) => t.symbol);
  // Two tokens often share a ticker; the address keeps the question exact.
  const overlapQuestion =
    'Which wallets hold more than one of these tokens: ' +
    data.tokens.map((t) => `${t.symbol} (${t.address})`).join(', ') +
    '?';

  return (
    <motion.article
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="mt-3 overflow-hidden rounded-xl border border-border-base bg-surface-raised"
    >
      <header className="flex items-baseline justify-between gap-3 px-4 pb-2 pt-3.5">
        <div>
          <h2 className="text-sm font-semibold">Most traded</h2>
          <p className="text-[11px] text-fg-subtle">By dollar volume, {WINDOW_LABEL[w]}</p>
        </div>
        <span className="text-[10px] text-fg-subtle">as of {asOf(data.asOf)}</span>
      </header>
      <CardNote text={note} />

      {data.tokens.length === 0 ? (
        <p className="border-t border-border-base px-4 py-4 text-sm text-fg-muted">
          Nothing to rank yet — the desk is still watching the first minutes of trading. Try again shortly.
        </p>
      ) : (
        <ol className="divide-y divide-border-base/60 border-t border-border-base">
          {data.tokens.map((t, i) => (
            <li key={t.address}>
              <motion.button
                type="button"
                disabled={disabled}
                onClick={() => onPickToken(t.address, t.symbol)}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: Math.min(i * 0.03, 0.3) }}
                className="group flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-surface focus-visible:bg-surface focus-visible:outline-none disabled:opacity-50"
                aria-label={`Open report on ${t.symbol}`}
              >
                <span className="w-4 shrink-0 text-right text-[11px] tabular-nums text-fg-subtle">{t.rank}</span>
                <TokenAvatar symbol={t.symbol} imageUrl={t.imageUrl} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{t.symbol}</p>
                  <p className="truncate text-[11px] text-fg-subtle">
                    {t.name && t.name !== t.symbol ? `${t.name} · ` : ''}
                    <span className="font-mono">{shortAddress(t.address)}</span>
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="text-sm tabular-nums">{usdCompact(t.volumeUsd[w])}</p>
                  <p className="text-[10px] tabular-nums text-fg-subtle">
                    cap {usdCompact(t.marketCap)}{' '}
                    <span className={cn(changeTone(t.priceChange24h))}>{percent(t.priceChange24h)}</span>
                  </p>
                </div>
                <ChevronRight size={14} className="shrink-0 text-fg-subtle transition-transform group-hover:translate-x-0.5" />
              </motion.button>
            </li>
          ))}
        </ol>
      )}

      {data.tokens.length >= 2 && (
        <div className="border-t border-border-base px-4 py-3">
          <button
            type="button"
            disabled={disabled}
            onClick={() => onAsk(overlapQuestion)}
            className="inline-flex min-h-10 w-full items-center justify-center gap-2 rounded-lg border border-border-strong px-3 text-sm font-medium transition-colors hover:bg-surface disabled:opacity-40 sm:w-auto"
          >
            <Users size={14} />
            Find wallets holding several of these
          </button>
          <p className="mt-2 text-[10px] leading-relaxed text-fg-subtle">
            Tap a token for its full report. Ranked from pools that traded in the last {data.observedMinutes} minutes;
            volumes are full {w === 'h24' ? '24-hour' : WINDOW_LABEL[w]} totals.
            {symbols.length !== new Set(symbols).size && ' Some tokens share a name — check the address.'}
          </p>
        </div>
      )}
    </motion.article>
  );
}
