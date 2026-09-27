'use client';

import { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { Check, ChevronDown, Copy, FlaskConical, Plus, TrendingDown, TrendingUp } from 'lucide-react';
import { amountShort, changeTone, pctSigned, timeAgo, usdExact, usdSigned } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { Holding, Portfolio } from '@/lib/types';
import { api } from '@/lib/api';
import { LiveBadge, TokenAvatar, clock, usePriceFlash } from '../research/shared';

/** Colour for a dollar figure as shown: a fraction of a cent reads $0.00 and stays neutral. */
const centsTone = (usd: number | null | undefined) => changeTone(usd == null ? usd : Math.round(usd * 100) / 100);

const CASH_SYMBOLS = new Set(['ETH', 'WETH', 'USDG', 'TUSDG']);
const HOLDINGS_SHOWN = 6;
const POLL_MS = 10_000;

/**
 * Fresh figures for the latest portfolio card, every ten seconds while the tab
 * is visible. Positions are priced from their pools on-chain, so values and
 * P&L move with the market. A card only takes figures for its own mode: after
 * switching between sandbox and live, an old card is never fed the other
 * account's numbers. A failed poll keeps what is on screen.
 */
function useLivePortfolio(initial: Portfolio, enabled: boolean): Portfolio {
  const [data, setData] = useState<Portfolio | null>(null);
  const mode = initial.mode ?? 'live';

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      if (document.visibilityState === 'hidden') return;
      try {
        const next = mode === 'sandbox' ? await api.sandbox() : await api.portfolio();
        if (!cancelled && (next.mode ?? 'live') === mode) setData(next);
      } catch {
        /* keep the last good figures */
      }
      if (!cancelled) timer = setTimeout(tick, POLL_MS);
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible' && !cancelled) {
        if (timer) clearTimeout(timer);
        void tick();
      }
    };

    // The card arrives fresh; the first refresh can wait a moment.
    timer = setTimeout(tick, 3_000);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled, mode]);

  return enabled && data ? data : initial;
}

/**
 * "How am I doing?" — four things, nothing else:
 *
 *   1. Balance: what it is worth, and up or down since the start.
 *   2. A few plain stats: put in, profit from sales, profit on what is held, trades.
 *   3. Holdings: tokens and cash in one list, each with its value.
 *   4. Activity: the last few trades.
 *
 * No agent comment: the card is the whole answer, and a comment written once
 * goes stale while these figures keep updating. A live wallet shows the same
 * layout without profit, which is tracked for the sandbox only.
 */
export function PortfolioCard({
  portfolio: initial,
  live = false,
  onAddFunds,
  onPickToken,
  disabled,
}: {
  portfolio: Portfolio;
  /** Keep this card's figures updating — the latest portfolio card only. */
  live?: boolean;
  onAddFunds?: () => void;
  /** Opens a token's report. */
  onPickToken?: (address: string, symbol: string) => void;
  disabled?: boolean;
}) {
  const portfolio = useLivePortfolio(initial, live);
  const paper = portfolio.mode === 'sandbox';
  const empty = portfolio.holdings.length === 0;
  const recent = portfolio.recentTrades ?? [];

  return (
    <motion.article
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      aria-label={paper ? 'Paper portfolio' : 'Portfolio'}
      className={cn(
        'mt-3 overflow-hidden rounded-xl border bg-surface-raised',
        paper ? 'border-amber-400/30' : 'border-border-base',
      )}
    >
      {paper && (
        <div className="flex items-center gap-1.5 border-b border-amber-400/20 bg-amber-400/[0.07] px-4 py-2 text-[11px] text-amber-200">
          <FlaskConical size={12} aria-hidden="true" />
          <span className="font-semibold">Paper money</span>
          <span className="text-amber-200/70">· real prices</span>
        </div>
      )}

      <Balance portfolio={portfolio} paper={paper} empty={empty} live={live} onAddFunds={onAddFunds} />

      {paper && !empty && <Stats portfolio={portfolio} />}

      {!empty && (
        <Holdings
          holdings={portfolio.holdings}
          paper={paper}
          onAddFunds={onAddFunds}
          onPickToken={onPickToken}
          disabled={disabled}
        />
      )}

      {paper && recent.length > 0 && <Activity recent={recent} />}

      {portfolio.unpricedCount > 0 && (
        <p className="border-t border-border-base px-4 py-2 text-[11px] text-fg-muted">
          {portfolio.unpricedCount} holding{portfolio.unpricedCount === 1 ? ' has' : 's have'} no price right now,
          so {portfolio.unpricedCount === 1 ? 'it isn’t' : 'they aren’t'} in the total.
        </p>
      )}

      {!paper && <Deposit address={portfolio.address} />}
    </motion.article>
  );
}

// ---------------------------------------------------------------- sections

function Balance({
  portfolio,
  paper,
  empty,
  live,
  onAddFunds,
}: {
  portfolio: Portfolio;
  paper: boolean;
  empty: boolean;
  live: boolean;
  onAddFunds?: () => void;
}) {
  const flash = usePriceFlash(portfolio.totalUsd);
  const ret = paper && !empty ? (portfolio.totalReturnUsd ?? null) : null;
  const up = ret != null && ret >= 0;

  return (
    <section className="px-4 py-4">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-[12px] text-fg-muted">Balance</p>
        <LiveBadge
          live={live}
          asOfIso={portfolio.asOf}
          liveHint={`Updates every few seconds from live prices. Last update ${clock(portfolio.asOf)}.`}
          snapshotHint="Only the latest portfolio card updates live — ask again for fresh numbers."
        />
      </div>
      <motion.p
        key={flash.key}
        initial={flash.dir ? { color: flash.dir === 'up' ? 'var(--positive)' : 'var(--negative)' } : false}
        animate={{ color: 'var(--fg)' }}
        transition={{ duration: 1.2, ease: 'easeOut' }}
        className="mt-1 text-[28px] font-semibold leading-none tracking-tight tabular-nums"
        aria-live={live ? 'polite' : undefined}
      >
        {usdExact(portfolio.totalUsd)}
      </motion.p>

      {ret != null && (
        <p className={cn('mt-2 inline-flex items-center gap-1 text-[13px] font-medium tabular-nums', centsTone(ret))}>
          {up ? <TrendingUp size={14} aria-hidden="true" /> : <TrendingDown size={14} aria-hidden="true" />}
          {up ? 'Up' : 'Down'} {usdExact(Math.abs(ret))}
          {portfolio.totalReturnPct != null && ` (${pctSigned(portfolio.totalReturnPct)})`}
          <span className="font-normal text-fg-muted">overall</span>
        </p>
      )}

      {empty && (
        <div className="mt-3">
          <p className="text-[13px] text-fg-muted">
            {paper
              ? 'Nothing here yet. Add paper ETH or USDG to start — it’s free.'
              : 'Nothing here yet. Send ETH and tokens to your deposit address below.'}
          </p>
          {paper && onAddFunds && (
            <button
              type="button"
              onClick={onAddFunds}
              className="mt-3 inline-flex min-h-10 items-center gap-1.5 rounded-lg bg-amber-400 px-4 text-sm font-semibold text-bg hover:opacity-90"
            >
              <Plus size={14} aria-hidden="true" />
              Add paper funds
            </button>
          )}
        </div>
      )}
    </section>
  );
}

/** Four numbers with one-or-two-word labels. */
function Stats({ portfolio }: { portfolio: Portfolio }) {
  const realized = portfolio.realizedUsd ?? 0;
  const unrealized = portfolio.unrealizedUsd ?? 0;
  const trades = portfolio.tradeCount ?? 0;
  return (
    <dl className="grid grid-cols-2 gap-px border-t border-border-base bg-border-base sm:grid-cols-4">
      <Stat label="Put in" value={usdExact(portfolio.netDepositsUsd ?? 0)} />
      <Stat
        label="Profit from sales"
        value={usdSigned(realized)}
        tone={centsTone(realized)}
        hint="Profit or loss you have already taken by selling, after network fees."
      />
      <Stat
        label="Profit on holdings"
        value={usdSigned(unrealized)}
        tone={centsTone(unrealized)}
        hint="What you would make or lose if you sold what you hold now."
      />
      <Stat label="Trades" value={String(trades)} />
    </dl>
  );
}

/** Tokens first, then cash — one list, one line each. */
function Holdings({
  holdings,
  paper,
  onAddFunds,
  onPickToken,
  disabled,
}: {
  holdings: Holding[];
  paper: boolean;
  onAddFunds?: () => void;
  onPickToken?: (address: string, symbol: string) => void;
  disabled?: boolean;
}) {
  const [all, setAll] = useState(false);
  const isCash = (h: Holding) => (h.kind ? h.kind === 'cash' : CASH_SYMBOLS.has(h.symbol.toUpperCase()));
  const ordered = [...holdings.filter((h) => !isCash(h)), ...holdings.filter(isCash)];
  const shown = all ? ordered : ordered.slice(0, HOLDINGS_SHOWN);

  return (
    <section className="border-t border-border-base" aria-label="Holdings">
      <div className="px-4 pt-3">
        <SectionTitle
          aside={
            paper && onAddFunds ? (
              <button
                type="button"
                onClick={onAddFunds}
                className="inline-flex items-center gap-1 text-[11px] font-medium text-amber-300 hover:underline"
              >
                <Plus size={11} aria-hidden="true" /> Add funds
              </button>
            ) : undefined
          }
        >
          Holdings
        </SectionTitle>
      </div>
      <ul className="divide-y divide-border-base/60">
        {shown.map((h) => {
          const cash = isCash(h);
          const pnl = paper && !cash ? (h.pnlUsd ?? null) : null;
          const canOpen = !cash && !!onPickToken;
          return (
            <li key={h.address}>
              <button
                type="button"
                disabled={disabled || !canOpen}
                onClick={() => onPickToken?.(h.address, h.symbol)}
                title={canOpen ? `Open ${h.symbol}` : undefined}
                className="flex w-full items-center gap-3 px-4 py-2.5 text-left enabled:hover:bg-surface disabled:cursor-default"
              >
                <TokenAvatar symbol={h.symbol} imageUrl={h.imageUrl} size="sm" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-semibold">
                    {h.symbol}
                    {cash && <span className="ml-1.5 text-[11px] font-normal text-fg-subtle">cash</span>}
                  </p>
                  <p className="truncate text-[11px] tabular-nums text-fg-subtle">
                    {amountShort(h.balance)} {h.symbol}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <p className={cn('text-[13px] font-medium tabular-nums', h.valueUsd == null && 'text-fg-subtle')}>
                    {h.valueUsd == null ? 'No price' : usdExact(h.valueUsd)}
                  </p>
                  {pnl != null && (
                    <p className={cn('text-[11px] tabular-nums', centsTone(pnl))}>
                      {usdSigned(pnl)}
                      {h.pnlPct != null && ` (${pctSigned(h.pnlPct)})`}
                    </p>
                  )}
                </div>
              </button>
            </li>
          );
        })}
      </ul>
      {ordered.length > HOLDINGS_SHOWN && (
        <button
          type="button"
          onClick={() => setAll((a) => !a)}
          className="flex w-full items-center justify-center gap-1 border-t border-border-base/60 py-2 text-[12px] text-fg-muted hover:bg-surface hover:text-fg"
        >
          <ChevronDown size={13} className={cn('transition-transform', all && 'rotate-180')} aria-hidden="true" />
          {all ? 'Show fewer' : `Show all ${ordered.length}`}
        </button>
      )}
    </section>
  );
}

function Activity({ recent }: { recent: NonNullable<Portfolio['recentTrades']> }) {
  return (
    <section className="border-t border-border-base px-4 py-3" aria-label="Recent activity">
      <SectionTitle>Recent activity</SectionTitle>
      <ul className="space-y-2">
        {recent.map((t, i) => (
          <li key={`${t.at}-${i}`} className="flex items-baseline gap-2 text-[12px]">
            <span className="min-w-0 flex-1 truncate">
              <span className="text-fg-muted">{t.side === 'buy' ? 'Bought' : 'Sold'}</span>{' '}
              <span className="font-semibold">{t.symbol}</span>{' '}
              <span className="tabular-nums text-fg-muted">{usdExact(t.valueUsd)}</span>
              {t.realizedUsd != null && (
                <span className={cn('tabular-nums', centsTone(t.realizedUsd))}>
                  {' · '}
                  {t.realizedUsd >= 0 ? 'made ' : 'lost '}
                  {usdExact(Math.abs(t.realizedUsd))}
                </span>
              )}
            </span>
            <span className="shrink-0 text-[11px] text-fg-subtle">{timeAgo(t.at)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Deposit({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2 border-t border-border-base px-4 py-2.5">
      <span className="text-[10px] uppercase tracking-wide text-fg-subtle">Deposit</span>
      <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-fg-muted">{address}</code>
      <button
        type="button"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(address);
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
  );
}

// ------------------------------------------------------------------ parts

function SectionTitle({ children, aside }: { children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <div className="mb-1 flex items-baseline justify-between gap-3">
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">{children}</h3>
      {aside != null && <span className="text-[11px] text-fg-subtle">{aside}</span>}
    </div>
  );
}

function Stat({ label, value, tone, hint }: { label: string; value: string; tone?: string; hint?: string }) {
  return (
    <div className="min-w-0 bg-surface-raised px-4 py-2.5" title={hint}>
      <dt className="truncate text-[11px] text-fg-muted">{label}</dt>
      <dd className={cn('mt-0.5 truncate text-[14px] font-semibold tabular-nums', tone)}>{value}</dd>
    </div>
  );
}
