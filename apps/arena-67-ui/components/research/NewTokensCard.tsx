'use client';

import { motion } from 'motion/react';
import { ChevronRight } from 'lucide-react';
import { shortAddress } from '@/lib/utils';
import { ageShort, usdCompact } from '@/lib/format';
import type { NewTokens } from '@/lib/types';
import { TokenAvatar, asOf } from './shared';
import { CardNote } from '../chat/CardNote';

/**
 * "What just launched", as a list you can act on.
 *
 * Newest first. Each row shows how old the token is and how much liquidity is
 * in its pools — for a token this new, whether it can be traded at all is the
 * first question. Tapping a row opens its full report.
 */
export function NewTokensCard({
  data,
  onPickToken,
  disabled,
  note,
}: {
  data: NewTokens;
  onPickToken: (address: string, symbol: string) => void;
  disabled?: boolean;
  /** The agent's comment, shown inside the card. */
  note?: string;
}) {
  const symbols = data.tokens.map((t) => t.symbol);

  return (
    <motion.article
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="mt-3 overflow-hidden rounded-xl border border-border-base bg-surface-raised"
    >
      <header className="flex items-baseline justify-between gap-3 px-4 pb-2 pt-3.5">
        <div>
          <h2 className="text-sm font-semibold">New tokens</h2>
          <p className="text-[11px] text-fg-subtle">
            Launched in the last {data.maxAgeHours} hours, with liquidity added
          </p>
        </div>
        <span className="text-[10px] text-fg-subtle">as of {asOf(data.asOf)}</span>
      </header>
      <CardNote text={note} />

      {data.tokens.length === 0 ? (
        <p className="border-t border-border-base px-4 py-4 text-sm text-fg-muted">
          No token has launched with liquidity in the last few hours. New launches show up here within a minute or two.
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
                <TokenAvatar symbol={t.symbol} imageUrl={t.imageUrl} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{t.symbol}</p>
                  <p className="truncate text-[11px] text-fg-subtle">
                    {t.name && t.name !== t.symbol ? `${t.name} · ` : ''}
                    <span className="font-mono">{shortAddress(t.address)}</span>
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="text-sm tabular-nums">{ageShort(t.launchedAt)}</p>
                  <p className="text-[10px] tabular-nums text-fg-subtle">
                    liquidity {usdCompact(t.liquidityUsd)} · cap {usdCompact(t.marketCap)}
                  </p>
                </div>
                <ChevronRight size={14} className="shrink-0 text-fg-subtle transition-transform group-hover:translate-x-0.5" />
              </motion.button>
            </li>
          ))}
        </ol>
      )}

      {data.tokens.length > 0 && (
        <p className="border-t border-border-base px-4 py-2.5 text-[10px] leading-relaxed text-fg-subtle">
          Tap a token for its full report. Only tokens with at least {usdCompact(data.minLiquidityUsd)} of liquidity
          are listed. Brand-new tokens can move very fast.
          {symbols.length !== new Set(symbols).size && ' Some tokens share a name — check the address.'}
        </p>
      )}
    </motion.article>
  );
}
