'use client';

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { motion } from 'motion/react';
import Lenis from 'lenis';
import { Loader2 } from 'lucide-react';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { ageShort, usdCompact } from '@/lib/format';
import type { SidebarList, SidebarToken, SidebarView } from '@/lib/types';
import { TokenAvatar } from './shared';

const POLL_MS = 30_000;
const PAGE = 12;
const VIEW_KEY = 'a67.sidebar.view';

const VIEWS: Array<{ id: SidebarView; label: string; says: string; window?: string; minutes?: number }> = [
  { id: 'h1', label: '1h', says: 'Most traded in the last hour', window: 'the last hour', minutes: 60 },
  { id: 'h6', label: '6h', says: 'Most traded in the last 6 hours', window: 'the last 6 hours', minutes: 360 },
  { id: 'h24', label: '24h', says: 'Most traded in the last 24 hours', window: 'the last 24 hours', minutes: 1440 },
  { id: 'new', label: 'New', says: 'Just launched, with liquidity added' },
];

/** The tab chosen last time, read after hydration so the server render matches. */
function useSavedView(): SidebarView {
  return useSyncExternalStore(
    (changed) => {
      window.addEventListener('storage', changed);
      return () => window.removeEventListener('storage', changed);
    },
    savedView,
    () => 'h24',
  );
}

function savedView(): SidebarView {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    if (VIEWS.some((x) => x.id === v)) return v as SidebarView;
  } catch {
    /* storage blocked; use the default */
  }
  return 'h24';
}

/**
 * The research half of the arena.
 *
 * Two kinds of list behind one filter: the most traded tokens over the last
 * hour, 6 hours or day (by dollar volume), and new launches that already have
 * liquidity. Each row shows what a person weighs first — logo and name,
 * market cap, and how long ago it launched. A missing figure is a dash,
 * never a zero.
 */
export function TrendingPane({
  onPick,
}: {
  /** Address is what identifies the token; symbol is only for the transcript. */
  onPick: (address: string, symbol: string) => void;
}) {
  const saved = useSavedView();
  const [picked, setPicked] = useState<SidebarView | null>(null);
  const view = picked ?? saved;
  const [limit, setLimit] = useState(PAGE);
  const [list, setList] = useState<SidebarList | null>(null);
  const [failed, setFailed] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  // Only the latest request may land: a slow answer for the old tab must
  // not overwrite the new one.
  const ticket = useRef(0);

  useEffect(() => {
    const load = async () => {
      const mine = ++ticket.current;
      try {
        const next = await api.sidebar(view, limit);
        if (mine === ticket.current) {
          setList(next);
          setFailed(false);
        }
      } catch {
        if (mine === ticket.current) setFailed(true);
      } finally {
        if (mine === ticket.current) setLoadingMore(false);
      }
    };
    void load();
    const t = setInterval(() => {
      if (document.visibilityState !== 'hidden') void load();
    }, POLL_MS);
    return () => {
      clearInterval(t);
      ticket.current += 1;
    };
  }, [view, limit]);

  const hasList = list !== null;

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const lenis = new Lenis({ wrapper: el, content: el.firstElementChild as HTMLElement, duration: 0.8 });
    let raf = 0;
    const loop = (t: number) => { lenis.raf(t); raf = requestAnimationFrame(loop); };
    raf = requestAnimationFrame(loop);
    return () => { cancelAnimationFrame(raf); lenis.destroy(); };
  }, [hasList]);

  const choose = (v: SidebarView) => {
    if (v === view) return;
    setPicked(v);
    setLimit(PAGE);
    setList(null);
    setFailed(false);
    scroller.current?.scrollTo({ top: 0 });
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      /* not remembered; fine */
    }
  };

  // The list stays on screen while the longer one loads; the effect fetches it.
  const loadMore = () => {
    setLoadingMore(true);
    setLimit((n) => n + PAGE);
  };

  const meta = VIEWS.find((v) => v.id === view)!;
  const shown = list?.view === view ? list : null;
  const catchingUp =
    shown && meta.minutes != null && shown.observedMinutes != null && shown.observedMinutes < meta.minutes;

  return (
    <aside className="flex h-full flex-col border-l border-border-base bg-surface/40">
      <header className="px-4 pb-2 pt-3.5">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-1.5">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-fg-muted">Trending</h2>
            <Refreshing failed={failed} />
          </div>
          <div role="tablist" aria-label="Which tokens to show" className="flex rounded-lg bg-surface-raised p-0.5">
            {VIEWS.map((v) => (
              <button
                key={v.id}
                type="button"
                role="tab"
                aria-selected={view === v.id}
                title={v.says}
                onClick={() => choose(v.id)}
                className={cn(
                  'min-h-7 rounded-md px-2.5 text-[11px] font-medium transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60',
                  view === v.id ? 'bg-border-base text-fg' : 'text-fg-muted hover:text-fg',
                )}
              >
                {v.label}
              </button>
            ))}
          </div>
        </div>
        <p className="mt-2 text-[11px] text-fg-subtle">{meta.says}</p>
        {catchingUp && (
          <p className="mt-1 text-[10px] leading-snug text-fg-subtle">
            Still catching up: only tokens traded in the last {Math.max(1, shown.observedMinutes ?? 0)} min are
            ranked so far.
          </p>
        )}
      </header>

      <div ref={scroller} className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <div className="px-2 pb-4">
          {failed && !shown && (
            <p className="px-2 py-6 text-xs leading-relaxed text-fg-subtle">
              Couldn&apos;t load tokens right now. Trying again shortly.
            </p>
          )}

          {!failed && !shown &&
            Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="mx-1 mb-1.5 flex h-12 items-center gap-2.5 px-1.5">
                <div className="h-8 w-8 shrink-0 animate-pulse rounded-full bg-surface-raised/80" />
                <div className="h-8 flex-1 animate-pulse rounded-md bg-surface-raised/60" />
              </div>
            ))}

          {shown?.tokens.length === 0 && (
            <p className="px-2 py-6 text-xs leading-relaxed text-fg-subtle">
              {view === 'new'
                ? 'No new tokens with liquidity in the last few hours. New launches appear here within a minute or two.'
                : 'No trading seen yet. Check back in a minute.'}
            </p>
          )}

          {shown?.tokens.map((t, i) => (
            <Row key={t.address} t={t} i={i % PAGE} window={meta.window} onPick={onPick} />
          ))}

          {shown && shown.tokens.length > 0 && shown.tokens.length < shown.total && (
            <button
              type="button"
              onClick={loadMore}
              disabled={loadingMore}
              className="mx-auto mt-2 flex min-h-9 w-[calc(100%-1rem)] items-center justify-center gap-1.5 rounded-lg border border-border-base text-[12px] font-medium text-fg-muted transition-colors hover:bg-surface-raised hover:text-fg disabled:opacity-60"
            >
              {loadingMore && <Loader2 size={13} className="animate-spin" aria-hidden="true" />}
              {loadingMore ? 'Loading…' : 'Load more'}
            </button>
          )}
        </div>
      </div>
    </aside>
  );
}

function Row({
  t,
  i,
  window,
  onPick,
}: {
  t: SidebarToken;
  i: number;
  window?: string;
  onPick: (address: string, symbol: string) => void;
}) {
  const launched = t.launchedAt
    ? new Date(t.launchedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : null;
  const hint = [
    `${t.name} (${t.symbol}) · ${t.address.slice(0, 6)}…${t.address.slice(-4)}`,
    `Market cap ${usdCompact(t.marketCap)}`,
    `Traded ${usdCompact(t.volumeUsd)} in ${window ?? 'the last 24 hours'}`,
    `Liquidity ${usdCompact(t.liquidityUsd)}`,
    launched ? `Launched ${launched}` : null,
  ]
    .filter(Boolean)
    .join('\n');

  return (
    <motion.button
      type="button"
      onClick={() => onPick(t.address, t.symbol)}
      title={hint}
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
            <span className="shrink-0 tabular-nums text-[12px] text-fg">{usdCompact(t.marketCap)}</span>
          </div>
          <div className="flex items-baseline justify-between gap-2">
            <p className="truncate text-[11px] text-fg-muted">{t.name}</p>
            <span className="shrink-0 tabular-nums text-[11px] text-fg-subtle">{ageShort(t.launchedAt)}</span>
          </div>
        </div>
      </div>
    </motion.button>
  );
}

/**
 * Tells people the list keeps itself fresh: a slow loop while polling works,
 * a still amber dot when the last refresh failed (it keeps retrying).
 */
function Refreshing({ failed }: { failed: boolean }) {
  const label = failed
    ? 'Couldn’t refresh just now — retrying'
    : `Live — refreshes every ${POLL_MS / 1000} seconds`;
  return (
    <span role="status" aria-label={label} title={label} className="inline-flex h-3 w-3 items-center justify-center">
      {failed ? (
        <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
      ) : (
        <Loader2 size={12} className="text-positive motion-safe:animate-[spin_1.6s_linear_infinite]" aria-hidden="true" />
      )}
    </span>
  );
}
