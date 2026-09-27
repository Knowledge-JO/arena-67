'use client';

import { usdCompact } from '@/lib/format';
import { useTrending } from '@/lib/use-trending';

/**
 * The market tape: the most traded tokens over 24h, with their volume, when
 * the desk is reachable; when the backend is down the tape carries the platform words
 * instead of inventing tokens.
 */
export function Tape() {
  const { snap, failed } = useTrending();
  const tokens = snap?.tokens ?? null;
  const offline = failed || !tokens || tokens.length === 0;

  const cells = offline
    ? ['ARENA 67', 'ROBINHOOD CHAIN', 'UNISWAP V4']
    : tokens.slice(0, 12).map((t) => `${t.symbol} · ${usdCompact(t.volume24h)} 24h vol`);

  return (
    <div className="overflow-hidden border-y border-line bg-paper">
      <div className="flex w-max animate-tape whitespace-nowrap py-3 will-change-transform">
        {[...cells, ...cells].map((c, i) => (
          <span
            key={i}
            aria-hidden={i >= cells.length}
            className="mr-10 shrink-0 font-ticker text-xs uppercase tracking-[0.2em] text-ink-muted"
          >
            {c}
          </span>
        ))}
      </div>
    </div>
  );
}