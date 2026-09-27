'use client';

import { useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import Lenis from 'lenis';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import type { TrendingSnapshot } from '@/lib/types';

const POLL_MS = 30_000;

/**
 * The research half of the arena.
 *
 * Rows are labelled "pools", not "24h volume", because pool count is what the
 * backend actually measures. Showing a volume column we aren't computing would
 * be inventing numbers on a trading screen.
 */
export function TrendingPane({
  onPick,
}: {
  /** Address is what identifies the token; symbol is only for the transcript. */
  onPick: (address: string, symbol: string) => void;
}) {
  const [snap, setSnap] = useState<TrendingSnapshot | null>(null);
  const [failed, setFailed] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const s = await api.trending();
        if (alive) { setSnap(s); setFailed(false); }
      } catch {
        if (alive) setFailed(true);
      }
    };
    void load();
    const t = setInterval(load, POLL_MS);
    return () => { alive = false; clearInterval(t); };
  }, []);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const lenis = new Lenis({ wrapper: el, content: el.firstElementChild as HTMLElement, duration: 0.8 });
    let raf = 0;
    const loop = (t: number) => { lenis.raf(t); raf = requestAnimationFrame(loop); };
    raf = requestAnimationFrame(loop);
    return () => { cancelAnimationFrame(raf); lenis.destroy(); };
  }, [snap !== null]);

  const warming = snap && !snap.index.ready;

  return (
    <aside className="flex h-full flex-col border-l border-border-base bg-surface/40">
      <header className="flex items-baseline justify-between px-4 py-3.5">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-fg-muted">
          Trending
        </h2>
        {snap && (
          <span
            className={cn(
              'text-[10px]',
              snap.stale ? 'text-warning' : 'text-fg-subtle',
            )}
          >
            {warming
              ? 'indexing…'
              : snap.stale
                ? 'stale'
                : `${snap.index.pools} pools`}
          </span>
        )}
      </header>

      <div ref={scroller} className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <div className="px-2 pb-4">
          {failed && (
            <p className="px-2 py-6 text-xs leading-relaxed text-fg-subtle">
              Can&apos;t reach the desk. Start the backend on :9000.
            </p>
          )}

          {!failed && !snap &&
            Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="mx-1 mb-1.5 h-12 animate-pulse rounded-lg bg-surface-raised/60" />
            ))}

          {snap?.tokens.length === 0 && !warming && (
            <p className="px-2 py-6 text-xs text-fg-subtle">
              No tokens indexed yet.
            </p>
          )}

          {snap?.tokens.map((t, i) => (
            <motion.button
              key={t.address}
              type="button"
              onClick={() => onPick(t.address, t.symbol)}
              initial={{ opacity: 0, x: 6 }}
              animate={{ opacity: 1, x: 0 }}
              whileTap={{ scale: 0.97 }}
              transition={{ delay: Math.min(i * 0.03, 0.3), duration: 0.2 }}
              className={cn(
                'mb-0.5 w-full cursor-pointer rounded-lg px-2.5 py-2 text-left',
                'transition-colors hover:bg-surface-raised active:bg-border-base',
                'focus-visible:outline-none',
                'focus-visible:ring-2 focus-visible:ring-accent/60',
              )}
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate text-sm font-medium">{t.symbol}</span>
                <span className="shrink-0 tabular-nums text-[11px] text-fg-subtle">
                  {t.poolCount} {t.poolCount === 1 ? 'pool' : 'pools'}
                </span>
              </div>
              <p className="truncate text-[11px] text-fg-muted">{t.name}</p>
            </motion.button>
          ))}
        </div>
      </div>
    </aside>
  );
}
