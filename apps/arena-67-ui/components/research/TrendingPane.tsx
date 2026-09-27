'use client';

import { useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import Lenis from 'lenis';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { usdCompact } from '@/lib/format';
import type { TrendingSnapshot } from '@/lib/types';
import { TokenAvatar } from './shared';

const POLL_MS = 30_000;

/**
 * The research half of the arena.
 *
 * Tokens are ranked by how many pools have opened against them recently —
 * what the backend measures from the chain. Each row shows what a person
 * weighs first: its logo and name, market cap, and how long ago it launched.
 * A missing figure is a dash, never a zero.
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
              <div key={i} className="mx-1 mb-1.5 flex h-12 items-center gap-2.5 px-1.5">
                <div className="h-8 w-8 shrink-0 animate-pulse rounded-full bg-surface-raised/80" />
                <div className="h-8 flex-1 animate-pulse rounded-md bg-surface-raised/60" />
              </div>
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
              <div className="flex items-center gap-2.5">
                {/* Logo from the market listing; initials when there is none. */}
                <TokenAvatar symbol={t.symbol} imageUrl={t.imageUrl} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-sm font-medium">{t.symbol}</span>
                    <span className="shrink-0 tabular-nums text-[12px] text-fg" title="Market cap">
                      {usdCompact(t.marketCap)}
                    </span>
                  </div>
                  <div className="flex items-baseline justify-between gap-2">
                    <p className="truncate text-[11px] text-fg-muted">{t.name}</p>
                    <span
                      className="shrink-0 tabular-nums text-[11px] text-fg-subtle"
                      title={
                        t.launchedAt
                          ? `Launched ${new Date(t.launchedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} — when its first trading pool opened`
                          : 'Launch time unknown'
                      }
                    >
                      {ageShort(t.launchedAt)}
                    </span>
                  </div>
                </div>
              </div>
            </motion.button>
          ))}
        </div>
      </div>
    </aside>
  );
}

/**
 * How long ago a token launched, short enough for a sidebar: "45m old",
 * "3h old", "2d old", "4mo old". Launch is when its first trading pool opened
 * — the chain keeps no history to read the contract's own deploy time from.
 */
function ageShort(at: number | null | undefined, now = Date.now()): string {
  if (!at) return '—';
  const m = Math.max(0, (now - at) / 60_000);
  if (m < 60) return `${Math.max(1, Math.round(m))}m old`;
  const h = m / 60;
  if (h < 48) return `${Math.round(h)}h old`;
  const d = h / 24;
  if (d < 60) return `${Math.round(d)}d old`;
  return `${Math.round(d / 30)}mo old`;
}
