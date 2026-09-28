'use client';

import { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { AlertTriangle, CheckCircle2, ChevronDown, Info, ArrowUpRight, ShoppingCart } from 'lucide-react';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { usd, usdCompact, percent, changeTone, count } from '@/lib/format';
import type { HoldersBlock, Signal, TokenReport } from '@/lib/types';
import { SETTLED_HOLDERS } from '@/lib/types';
import {
  AddressChip,
  CountingBar,
  KIND,
  KindBadge,
  SectionTitle,
  Stat,
  TokenAvatar,
  age,
  asOf,
  pctOfSupply,
  useHolderProgress,
  useLiveMarket,
  LiveBadge,
  usePriceFlash,
  clock,
} from './shared';
import { CardNote } from '../chat/CardNote';

/**
 * The answer to "what do you know about X".
 *
 * Ordered for someone deciding whether to care: what it is and what it costs,
 * then the few things worth knowing in plain sentences, then the numbers, then
 * who holds it. The signals come before the figures on purpose — "most of the
 * supply is in ten wallets" is what a newcomer needs, and a grid of numbers
 * they cannot interpret would bury it.
 *
 * Holders may still be counting when the report is made. The card then polls
 * and fills its own holders section in when they are ready, so the user never
 * has to ask twice.
 *
 * The two most recent report cards in a conversation are `live`: price, market
 * cap and 24h change are read from the token's deepest pool every few seconds,
 * and the rest of the market figures refresh as the upstream does. Older cards
 * are snapshots and say so — a scrolled-back card quietly changing would make
 * the conversation around it wrong.
 */
export function TokenReportCard({
  report,
  onBuy,
  onAsk,
  disabled,
  live = false,
  note,
}: {
  /** The agent's comment, shown inside the card. */
  note?: string;
  report: TokenReport;
  /** Keep this card's market figures updating. */
  live?: boolean;
  onBuy: (address: string, symbol: string) => void;
  onAsk: (text: string) => void;
  disabled?: boolean;
}) {
  const { token, signals } = report;
  const liveData = useLiveMarket(token.address, live);
  // Live figures when we have them; the report's own otherwise, so the card
  // renders immediately and never goes blank if a poll fails.
  const market = liveData?.market ?? report.market;
  const priceUsd = liveData ? liveData.priceUsd : market?.priceUsd;
  const change24h = liveData ? liveData.priceChange24h : market?.priceChange.h24;
  const marketCap = liveData ? liveData.marketCap : market?.marketCap;
  const flash = usePriceFlash(priceUsd);
  const [holders, setHolders] = useState<HoldersBlock>(report.holders);
  const counting = !SETTLED_HOLDERS.has(holders.status);
  const progress = useHolderProgress([token.address], counting);
  const holderLive = progress[token.address.toLowerCase()];

  // When the count finishes, fetch the holders and show them in place.
  useEffect(() => {
    if (!counting || holderLive?.status !== 'ready') return;
    let cancelled = false;
    api
      .tokenHolders(token.address, 10)
      .then((h) => !cancelled && setHolders(h))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [counting, holderLive?.status, token.address]);

  const name = token.name || token.symbol || 'Unknown token';
  const symbol = token.symbol || '?';

  return (
    <motion.article
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="mt-3 overflow-hidden rounded-xl border border-border-base bg-surface-raised"
      aria-label={`Report on ${name}`}
    >
      {/* Identity and price */}
      <header className="flex items-start gap-3 px-4 pb-3 pt-4">
        <TokenAvatar symbol={symbol} imageUrl={token.imageUrl} size="lg" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h2 className="truncate text-base font-semibold tracking-tight">{name}</h2>
            <span className="text-xs text-fg-muted">{symbol}</span>
            <LiveBadge live={live} asOfIso={report.asOf} />
          </div>
          <AddressChip address={token.address} explorer={report.explorer} kind="token" className="mt-0.5" />
        </div>
        <div className="shrink-0 text-right">
          <motion.p
            key={flash.key}
            initial={flash.dir ? { color: flash.dir === 'up' ? 'var(--positive)' : 'var(--negative)' } : false}
            animate={{ color: 'var(--fg)' }}
            transition={{ duration: 1.2, ease: 'easeOut' }}
            className="text-base font-semibold tabular-nums"
            aria-live={live ? 'polite' : undefined}
          >
            {usd(priceUsd)}
          </motion.p>
          {change24h != null && (
            <p className={cn('text-xs tabular-nums', changeTone(change24h))}>
              {percent(change24h)} <span className="text-fg-subtle">24h</span>
            </p>
          )}
        </div>
      </header>
      <CardNote text={note} />

      <div className="flex flex-col gap-4 px-4 pb-4">
        {signals.length > 0 && <Signals signals={signals} />}

        {market ? (
          <section aria-label="Market">
            <SectionTitle>Market</SectionTitle>
            <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
              <Stat
                label="Market cap"
                value={usdCompact(marketCap)}
                hint="Price × tokens in circulation: roughly what the whole token is worth."
              />
              <Stat
                label="Liquidity"
                value={usdCompact(market.liquidityUsd)}
                hint="Money available in pools to trade against. Low liquidity means prices jump on small trades."
              />
              <Stat label="Volume 24h" value={usdCompact(market.volumeUsd.h24)} hint="Total traded in the last 24 hours." />
              <Stat label="Age" value={age(market.firstPoolAt)} hint="Time since its first trading pool opened." />
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px]">
              {(['h1', 'h6', 'h24'] as const).map((w) => (
                <span key={w} className="tabular-nums text-fg-subtle">
                  {w.replace('h', '')}h{' '}
                  <span className={changeTone(w === 'h24' ? change24h : market.priceChange[w])}>
                    {percent(w === 'h24' ? change24h : market.priceChange[w])}
                  </span>
                </span>
              ))}
            </div>
            <BuySellBar buys={market.buys.h24} sells={market.sells.h24} />
          </section>
        ) : (
          <p className="rounded-lg bg-surface px-3 py-2.5 text-xs text-fg-muted">
            No exchange lists this token yet, so there is no price, volume or market cap to show.
          </p>
        )}

        <section aria-label="Holders">
          <SectionTitle
            aside={
              holders.status === 'ready' && holders.holderCount != null ? (
                <span className="text-xs tabular-nums text-fg-muted">{count(holders.holderCount)} holders</span>
              ) : undefined
            }
          >
            Who holds it
          </SectionTitle>
          <HoldersSection
            holders={holders}
            live={holderLive}
            explorer={report.explorer}
            onAsk={onAsk}
            disabled={disabled}
          />
        </section>

        <footer className="flex flex-col gap-3 border-t border-border-base pt-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap gap-1.5">
            {[...token.websites, ...token.socials].slice(0, 5).map((l) => (
              <a
                key={l.url}
                href={l.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 rounded-full border border-border-base px-2 py-1 text-[11px] capitalize text-fg-muted transition-colors hover:border-border-strong hover:text-fg"
              >
                {l.label}
                <ArrowUpRight size={10} />
              </a>
            ))}
            {token.websites.length + token.socials.length === 0 && (
              <span className="text-[11px] text-fg-subtle">No links listed</span>
            )}
          </div>
          <button
            type="button"
            disabled={disabled || report.pools.length === 0}
            onClick={() => onBuy(token.address, symbol)}
            title={report.pools.length === 0 ? 'No pool on Arena 67 can trade this token yet.' : undefined}
            className="inline-flex min-h-10 items-center justify-center gap-1.5 rounded-lg bg-accent px-4 text-sm font-semibold text-accent-fg transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <ShoppingCart size={14} />
            Buy {symbol}
          </button>
        </footer>
        <p className="-mt-2 text-[10px] text-fg-subtle">
          {live && liveData
            ? liveData.source === 'chain' && liveData.pool
              ? `Live price from the ${liveData.pool.quoteSymbol} pool, updated ${clock(liveData.at)}. `
              : `Live, refreshed every 30 seconds — updated ${clock(liveData.at)}. `
            : `Report as of ${asOf(report.asOf)}. `}
          Buying shows you a quote first — nothing happens until you confirm.
        </p>
      </div>
    </motion.article>
  );
}

const TONE = {
  caution: { icon: AlertTriangle, cls: 'text-amber-300' },
  good: { icon: CheckCircle2, cls: 'text-positive' },
  info: { icon: Info, cls: 'text-fg-subtle' },
} as const;

function Signals({ signals }: { signals: Signal[] }) {
  // Cautions first: they are why someone reads this section at all.
  const order = { caution: 0, good: 1, info: 2 } as const;
  const sorted = [...signals].sort((a, b) => order[a.tone] - order[b.tone]);
  return (
    <section aria-label="Things to know" className="rounded-lg bg-surface px-3 py-2.5">
      <SectionTitle>Things to know</SectionTitle>
      <ul className="flex flex-col gap-1.5">
        {sorted.map((s) => {
          const t = TONE[s.tone];
          const Icon = t.icon;
          return (
            <li key={s.text} className="flex items-start gap-2 text-[13px] leading-snug">
              <Icon size={14} className={cn('mt-0.5 shrink-0', t.cls)} aria-hidden="true" />
              <span>{s.text}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function BuySellBar({ buys, sells }: { buys: number | null; sells: number | null }) {
  const b = buys ?? 0;
  const s = sells ?? 0;
  if (b + s === 0) return null;
  const share = (b / (b + s)) * 100;
  return (
    <div className="mt-3" aria-label={`${b} buys and ${s} sells in 24 hours`}>
      <div className="flex justify-between text-[11px] tabular-nums">
        <span className="text-positive">{count(b)} buys</span>
        <span className="text-fg-subtle">last 24h</span>
        <span className="text-negative">{count(s)} sells</span>
      </div>
      <div className="mt-1 flex h-1.5 overflow-hidden rounded-full bg-negative/60">
        <div className="h-full bg-positive" style={{ width: `${share}%` }} />
      </div>
    </div>
  );
}

/** Supply split into the parts that mean different things. */
function SupplyBar({ breakdown }: { breakdown: NonNullable<HoldersBlock['breakdown']> }) {
  const parts = [
    { key: 'Top 10 wallets', value: breakdown.top10WalletsPercent ?? 0, cls: 'bg-fg' },
    { key: 'Liquidity pools', value: breakdown.poolsPercent ?? 0, cls: 'bg-sky-400' },
    { key: 'Contracts', value: breakdown.contractsPercent ?? 0, cls: 'bg-amber-400' },
    { key: 'Burned', value: breakdown.burnedPercent ?? 0, cls: 'bg-negative' },
  ].filter((p) => p.value > 0);
  const rest = Math.max(0, 100 - parts.reduce((s, p) => s + p.value, 0));

  return (
    <div>
      <div className="flex h-2 overflow-hidden rounded-full bg-border-strong" role="img" aria-label="How the supply is split">
        {parts.map((p) => (
          <div key={p.key} className={cn('h-full', p.cls)} style={{ width: `${p.value}%` }} />
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
        {parts.map((p) => (
          <span key={p.key} className="inline-flex items-center gap-1.5 text-fg-muted">
            <span className={cn('h-2 w-2 rounded-sm', p.cls)} />
            {p.key} <span className="tabular-nums text-fg">{pctOfSupply(p.value)}</span>
          </span>
        ))}
        <span className="inline-flex items-center gap-1.5 text-fg-muted">
          <span className="h-2 w-2 rounded-sm bg-border-strong" />
          Everyone else <span className="tabular-nums text-fg">{pctOfSupply(rest)}</span>
        </span>
      </div>
    </div>
  );
}

function HoldersSection({
  holders,
  live,
  explorer,
  onAsk,
  disabled,
}: {
  holders: HoldersBlock;
  live?: { status: HoldersBlock['status']; progress: number };
  explorer: string;
  onAsk: (text: string) => void;
  disabled?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [legend, setLegend] = useState(false);

  if (holders.status === 'too_large') {
    return (
      <p className="rounded-lg bg-surface px-3 py-2.5 text-xs text-fg-muted">
        This token is held by too many wallets to list its holders here — usually the case for tokenised stocks.
      </p>
    );
  }
  if (holders.status === 'unavailable' || holders.status === 'failed') {
    return (
      <p className="rounded-lg bg-surface px-3 py-2.5 text-xs text-fg-muted">
        Holder data could not be read for this token right now. Asking again later usually works.
      </p>
    );
  }
  if (holders.status !== 'ready') {
    return <CountingBar progress={live?.progress ?? holders.progress} status={live?.status ?? holders.status} />;
  }
  if (holders.top.length === 0) {
    return <p className="text-xs text-fg-muted">No one holds this token yet.</p>;
  }

  const rows = expanded ? holders.top : holders.top.slice(0, 5);
  const max = Math.max(...holders.top.map((h) => h.percent ?? 0), 1);

  return (
    <div className="flex flex-col gap-3">
      {holders.breakdown && <SupplyBar breakdown={holders.breakdown} />}

      <ol className="flex flex-col divide-y divide-border-base/60 rounded-lg bg-surface">
        {rows.map((h) => (
          <li key={h.address} className="flex items-center gap-2 px-3 py-2">
            <span className="w-5 shrink-0 text-right text-[11px] tabular-nums text-fg-subtle">{h.rank}</span>
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
                <AddressChip address={h.address} explorer={explorer} />
                <KindBadge kind={h.label} name={h.labelName} />
              </div>
              <div className="mt-1 h-1 overflow-hidden rounded-full bg-border-base">
                <div
                  className={cn('h-full rounded-full', h.label === 'wallet' ? 'bg-fg/70' : 'bg-fg-subtle/60')}
                  style={{ width: `${((h.percent ?? 0) / max) * 100}%` }}
                />
              </div>
            </div>
            <span className="w-14 shrink-0 text-right text-xs tabular-nums">{pctOfSupply(h.percent)}</span>
            {h.label === 'wallet' && (
              <button
                type="button"
                disabled={disabled}
                onClick={() => onAsk(`What does ${h.address} hold?`)}
                title="See what else this wallet holds"
                aria-label="See what else this wallet holds"
                className="shrink-0 rounded-md px-1.5 py-1 text-[10px] text-fg-subtle hover:bg-border-base hover:text-fg disabled:opacity-40"
              >
                Holdings
              </button>
            )}
          </li>
        ))}
      </ol>

      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
        {holders.top.length > 5 ? (
          <button
            type="button"
            onClick={() => setExpanded((e) => !e)}
            className="inline-flex items-center gap-1 text-fg-muted hover:text-fg"
          >
            <ChevronDown size={12} className={cn('transition-transform', expanded && 'rotate-180')} />
            {expanded ? 'Show fewer' : `Show top ${holders.top.length}`}
          </button>
        ) : (
          <span />
        )}
        <button type="button" onClick={() => setLegend((l) => !l)} className="text-fg-subtle hover:text-fg">
          What do these labels mean?
        </button>
      </div>

      {legend && (
        <dl className="grid gap-1.5 rounded-lg bg-surface px-3 py-2.5 text-[11px] sm:grid-cols-2">
          {(Object.keys(KIND) as Array<keyof typeof KIND>).map((k) => (
            <div key={k} className="flex items-start gap-2">
              <dt>
                <KindBadge kind={k} />
              </dt>
              <dd className="text-fg-muted">{KIND[k].hint}</dd>
            </div>
          ))}
        </dl>
      )}

      {holders.drift && (
        <p className="text-[11px] text-amber-300">
          Holder counts are approximate for this token (its balances don’t add up from its transfers). The top holders
          above are exact.
        </p>
      )}
      <p className="text-[10px] text-fg-subtle">
        Percentages are shares of the total supply. Balances read live from Robinhood Chain.
      </p>
    </div>
  );
}
