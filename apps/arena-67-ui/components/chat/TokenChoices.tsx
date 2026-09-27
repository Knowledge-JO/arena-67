'use client';

import { motion } from 'motion/react';
import { cn, shortAddress } from '@/lib/utils';
import { usd, usdCompact, percent, changeTone } from '@/lib/format';
import type { TokenChoice } from '@/lib/types';

/**
 * The research disambiguation card.
 *
 * Eight tokens sharing a ticker is the normal case here, not an edge one, and
 * as a prose list their addresses are indistinguishable — a human cannot pick
 * between `0x97af…cccc` and `0xa55d…6b83` from the hex alone. Market cap and
 * volume are what actually separate the token someone means from the copies
 * trading on its name, so they lead.
 */
export function TokenChoices({
  candidates,
  onPick,
  disabled,
}: {
  candidates: TokenChoice[];
  onPick: (address: string, symbol: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="mt-3 flex flex-col gap-1.5">
      {candidates.map((c, i) => (
        <motion.button
          key={c.address}
          type="button"
          disabled={disabled}
          onClick={() => onPick(c.address, c.symbol)}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: Math.min(i * 0.04, 0.3), duration: 0.2 }}
          whileTap={disabled ? undefined : { scale: 0.99 }}
          className={cn(
            'group w-full cursor-pointer rounded-xl border border-border-base',
            'bg-surface-raised px-3.5 py-3 text-left transition-colors',
            'hover:border-accent/60 active:bg-border-base',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60',
            disabled && 'pointer-events-none opacity-50',
          )}
        >
          <div className="flex items-start gap-3">
            {c.imageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={c.imageUrl}
                alt=""
                className="h-8 w-8 shrink-0 rounded-full bg-border-base object-cover"
              />
            ) : (
              <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-border-base text-[9px] font-semibold text-fg-muted">
                {c.symbol.slice(0, 3).toUpperCase()}
              </div>
            )}

            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate text-sm font-semibold tracking-tight">
                  {c.symbol}
                </span>
                {c.priceUsd != null && (
                  <span className="shrink-0 text-xs tabular-nums">
                    {usd(c.priceUsd)}
                  </span>
                )}
              </div>

              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate text-[11px] text-fg-muted">
                  {c.name}
                </span>
                {c.priceChange24h != null && (
                  <span
                    className={cn(
                      'shrink-0 text-[10px] tabular-nums',
                      changeTone(c.priceChange24h),
                    )}
                  >
                    {percent(c.priceChange24h)}
                  </span>
                )}
              </div>

              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-fg-subtle">
                <code className="font-mono">{shortAddress(c.address)}</code>
                {/*
                  Cap and volume are the discriminators, so they are always
                  labelled — an unlabelled dash would read as "zero" rather
                  than "not priced anywhere".
                */}
                <span className="tabular-nums">
                  cap {usdCompact(c.marketCap)}
                </span>
                <span className="tabular-nums">
                  vol {usdCompact(c.volume24h)}
                </span>
                <span className="tabular-nums">
                  {c.poolCount} {c.poolCount === 1 ? 'pool' : 'pools'}
                </span>
              </div>
            </div>
          </div>
        </motion.button>
      ))}
    </div>
  );
}
