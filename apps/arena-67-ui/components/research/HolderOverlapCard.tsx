'use client';

import { useMemo, useState } from 'react';
import { motion } from 'motion/react';
import { Check, Loader2, RefreshCw, Wallet } from 'lucide-react';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import type { HolderOverlap } from '@/lib/types';
import { AddressChip, asOf, pctOfSupply, useHolderProgress } from './shared';

const INITIAL_ROWS = 8;

/**
 * Wallets that show up among the top holders of more than one token.
 *
 * The comparison happened on the server; this only shows it. Tokens still
 * being counted are shown with their progress, and when one finishes a button
 * offers to re-run the comparison right here — the result updates in place
 * rather than the user having to know to ask again.
 */
export function HolderOverlapCard({
  data: initial,
  onAsk,
  disabled,
}: {
  data: HolderOverlap;
  onAsk: (text: string) => void;
  disabled?: boolean;
}) {
  const [data, setData] = useState(initial);
  const [rerunning, setRerunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  const pending = data.tokens.filter((t) => t.status !== 'ready' && t.status !== 'unavailable');
  const compared = data.tokens.filter((t) => t.status === 'ready');
  const live = useHolderProgress(
    pending.map((t) => t.address),
    pending.length > 0,
  );
  const newlyReady = pending.filter((t) => live[t.address.toLowerCase()]?.status === 'ready');

  const rerun = async () => {
    setRerunning(true);
    setError(null);
    try {
      setData(
        await api.commonHolders({
          tokens: data.tokens.map((t) => t.address),
          topN: data.topN,
          minTokens: data.minTokens,
          include: data.include,
        }),
      );
      setShowAll(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRerunning(false);
    }
  };

  const total = data.overlapTotal ?? data.overlaps.length;
  const rows = showAll ? data.overlaps : data.overlaps.slice(0, INITIAL_ROWS);
  const bySymbolCount = useMemo(() => {
    const n = new Map<string, number>();
    for (const t of data.tokens) n.set(t.symbol, (n.get(t.symbol) ?? 0) + 1);
    return n;
  }, [data.tokens]);
  /** A ticker shared by two compared tokens gets its address tail, or the pills are ambiguous. */
  const tag = (symbol: string, address: string) =>
    (bySymbolCount.get(symbol) ?? 0) > 1 ? `${symbol}·${address.slice(-4)}` : symbol;

  return (
    <motion.article
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="mt-3 overflow-hidden rounded-xl border border-border-base bg-surface-raised"
    >
      <header className="px-4 pb-3 pt-3.5">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-sm font-semibold">Wallets holding more than one</h2>
          <span className="shrink-0 text-[10px] text-fg-subtle">as of {asOf(data.asOf)}</span>
        </div>
        <p className="mt-0.5 text-[11px] text-fg-subtle">
          Compared the top {data.topN} {data.include.length === 1 && data.include[0] === 'wallet' ? 'wallets' : 'holders'}{' '}
          of {compared.length} token{compared.length === 1 ? '' : 's'}. Pools, burn addresses and contracts are left out.
        </p>

        <ul className="mt-2.5 flex flex-wrap gap-1.5" aria-label="Tokens compared">
          {data.tokens.map((t) => {
            const p = live[t.address.toLowerCase()];
            const ready = t.status === 'ready';
            const nowReady = !ready && p?.status === 'ready';
            return (
              <li
                key={t.address}
                title={t.address}
                className={cn(
                  'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]',
                  ready ? 'border-border-strong text-fg' : 'border-dashed border-border-strong text-fg-subtle',
                )}
              >
                {ready || nowReady ? (
                  <Check size={10} className={nowReady ? 'text-positive' : 'text-fg-subtle'} />
                ) : t.status === 'unavailable' ? null : (
                  <Loader2 size={10} className="animate-spin" />
                )}
                {tag(t.symbol, t.address)}
                {!ready && !nowReady && t.status !== 'unavailable' && (
                  // Queued is "not started", which 0% would misread as "no holders".
                  <span className="tabular-nums">
                    {(p?.status ?? t.status) === 'indexing'
                      ? `${Math.round(p?.progress ?? t.progress)}%`
                      : 'waiting'}
                  </span>
                )}
                {t.status === 'unavailable' && <span>· unreadable</span>}
              </li>
            );
          })}
        </ul>

        {pending.length > 0 && (
          <div className="mt-2.5 flex flex-col gap-2 rounded-lg bg-surface px-3 py-2 text-[11px] text-fg-muted sm:flex-row sm:items-center sm:justify-between">
            <span>
              {newlyReady.length > 0
                ? `${newlyReady.length} more token${newlyReady.length === 1 ? ' is' : 's are'} ready to include.`
                : `Still counting holders for ${pending.length} token${pending.length === 1 ? '' : 's'} — they'll be added when ready.`}
            </span>
            {newlyReady.length > 0 && (
              <button
                type="button"
                onClick={rerun}
                disabled={rerunning}
                className="inline-flex min-h-8 shrink-0 items-center justify-center gap-1.5 rounded-md bg-accent px-3 text-xs font-semibold text-accent-fg disabled:opacity-50"
              >
                <RefreshCw size={12} className={rerunning ? 'animate-spin' : undefined} />
                Update results
              </button>
            )}
          </div>
        )}
        {error && <p className="mt-2 text-[11px] text-negative">{error}</p>}
      </header>

      {compared.length < 2 ? (
        <p className="border-t border-border-base px-4 py-4 text-sm text-fg-muted">
          At least two tokens need their holders counted before they can be compared. This card will offer to update
          as soon as they are.
        </p>
      ) : data.overlaps.length === 0 ? (
        <p className="border-t border-border-base px-4 py-4 text-sm text-fg-muted">
          No wallet appears among the top holders of more than one of these tokens.
        </p>
      ) : (
        <>
          <p className="border-t border-border-base px-4 pb-1 pt-2.5 text-[11px] text-fg-subtle">
            {total} wallet{total === 1 ? '' : 's'} found. Each tag shows the token, the wallet’s rank among its holders, and
            its share of supply.
          </p>
          <ol className="divide-y divide-border-base/60">
            {rows.map((h) => (
              <li key={h.address} className="flex flex-col gap-1.5 px-4 py-2.5 sm:flex-row sm:items-center sm:gap-3">
                <div className="flex min-w-0 items-center gap-2 sm:w-52 sm:shrink-0">
                  <AddressChip address={h.address} explorer={data.explorer} />
                  <span className="shrink-0 rounded-full bg-fg/10 px-1.5 py-0.5 text-[10px] font-medium">
                    {h.tokens.length} tokens
                  </span>
                </div>
                <div className="flex min-w-0 flex-1 flex-wrap gap-1">
                  {h.tokens.map((t) => (
                    <span
                      key={t.address}
                      title={`#${t.rank} holder of ${t.symbol}, ${pctOfSupply(t.percent)} of its supply`}
                      className="inline-flex items-center gap-1 rounded-md bg-surface px-1.5 py-0.5 text-[11px]"
                    >
                      <span className="font-medium">{tag(t.symbol, t.address)}</span>
                      <span className="tabular-nums text-fg-subtle">
                        #{t.rank} · {pctOfSupply(t.percent)}
                      </span>
                    </span>
                  ))}
                </div>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => onAsk(`What does ${h.address} hold?`)}
                  className="inline-flex shrink-0 items-center gap-1 self-start rounded-md px-1.5 py-1 text-[11px] text-fg-muted hover:bg-border-base hover:text-fg disabled:opacity-40 sm:self-center"
                >
                  <Wallet size={11} />
                  Holdings
                </button>
              </li>
            ))}
          </ol>
          {data.overlaps.length > INITIAL_ROWS && (
            <button
              type="button"
              onClick={() => setShowAll((s) => !s)}
              className="w-full border-t border-border-base px-4 py-2 text-[11px] text-fg-muted hover:bg-surface hover:text-fg"
            >
              {showAll ? 'Show fewer' : `Show all ${data.overlaps.length}`}
            </button>
          )}
          {data.overlapTotal != null && data.overlapTotal > data.overlaps.length && (
            <p className="px-4 pb-3 text-[10px] text-fg-subtle">
              Showing the {data.overlaps.length} strongest of {data.overlapTotal}.
            </p>
          )}
        </>
      )}
    </motion.article>
  );
}
