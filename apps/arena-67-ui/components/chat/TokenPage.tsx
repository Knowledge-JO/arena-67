'use client';

import { useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { Copy, Check, Globe, ArrowUpRight, AlertTriangle } from 'lucide-react';
import { cn, shortAddress } from '@/lib/utils';
import { usd, usdCompact, percent, changeTone, count } from '@/lib/format';
import type { TokenPool, TokenStats, TokenLink } from '@/lib/types';

interface Props {
  token: {
    address: string;
    symbol: string;
    name: string;
    decimals: number;
    imageUrl: string | null;
    websites: TokenLink[];
    socials: TokenLink[];
  };
  stats: TokenStats | null;
  pools: TokenPool[];
  selectedPoolId?: string;
  degraded: boolean;
  busy?: boolean;
  spent?: boolean;
  onSelectPool: (poolId: string) => void;
  onSubmitAmount: (amount: number) => void;
  /** Sizes the trade as a share of what is held; the backend uses the exact balance. */
  onSubmitPercent?: (percent: number) => void;
  /** Buying or selling. Absent on cards saved before it existed — treated as a buy. */
  action?: 'buy' | 'sell';
  /** What is held of the asset being spent, once a venue is chosen. */
  available?: { amount: string; symbol: string } | null;
}

const SHARES = [
  [25, '25%'],
  [50, '50%'],
  [75, '75%'],
  [100, 'Max'],
] as const;

/**
 * The token page: what you need to decide before committing money.
 *
 * v1 asked "how much?" with nothing but a symbol on screen. Everything here
 * exists so that question is answerable — who this token is, what it is worth,
 * and which venue the trade would actually route through.
 *
 * Absent data shows as a dash. The backend returns null when it genuinely
 * cannot price something, and a zero would read as a fact.
 */
export function TokenPage({
  token,
  stats,
  pools,
  selectedPoolId,
  degraded,
  busy,
  spent,
  onSelectPool,
  onSubmitAmount,
  onSubmitPercent,
  action = 'buy',
  available,
}: Props) {
  const selling = action === 'sell';
  const [copied, setCopied] = useState(false);
  const [amount, setAmount] = useState('');
  const amountRef = useRef<HTMLInputElement>(null);

  const chosen = pools.find((p) => p.poolId === selectedPoolId);

  // Once a venue is picked the amount is the only thing left to say, so put
  // the cursor there rather than making the user find it.
  useEffect(() => {
    if (chosen && !spent) amountRef.current?.focus();
  }, [chosen, spent]);

  const submit = () => {
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0 || busy) return;
    onSubmitAmount(n);
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22, ease: 'easeOut' }}
      className="mt-3 overflow-hidden rounded-xl border border-border-base bg-surface-raised"
    >
      <header className="flex items-start gap-3 p-3.5">
        {token.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={token.imageUrl}
            alt=""
            className="h-10 w-10 shrink-0 rounded-full bg-border-base object-cover"
          />
        ) : (
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-border-base text-xs font-semibold text-fg-muted">
            {token.symbol.slice(0, 3).toUpperCase()}
          </div>
        )}

        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <h3 className="truncate font-semibold tracking-tight">{token.symbol}</h3>
            <span className="truncate text-xs text-fg-muted">{token.name}</span>
          </div>

          <div className="mt-1 flex items-center gap-1.5">
            <code className="font-mono text-[11px] text-fg-subtle">
              {shortAddress(token.address)}
            </code>
            <button
              type="button"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(token.address);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1200);
                } catch {
                  /* clipboard blocked; address is still selectable */
                }
              }}
              aria-label="Copy contract address"
              className="rounded p-0.5 text-fg-subtle hover:bg-border-base hover:text-fg"
            >
              {copied ? <Check size={11} className="text-positive" /> : <Copy size={11} />}
            </button>

            {[...token.websites, ...token.socials].slice(0, 4).map((l) => (
              <a
                key={l.url}
                href={l.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 rounded-full border border-border-base px-1.5 py-0.5 text-[10px] text-fg-muted transition-colors hover:border-border-strong hover:text-fg"
              >
                <Globe size={9} />
                {l.label}
              </a>
            ))}
          </div>
        </div>

        {stats?.priceUsd != null && (
          <div className="shrink-0 text-right">
            <div className="text-sm font-medium tabular-nums">{usd(stats.priceUsd)}</div>
            <div className={cn('text-[11px] tabular-nums', changeTone(stats.priceChange24h))}>
              {percent(stats.priceChange24h)}
            </div>
          </div>
        )}
      </header>

      {stats && (
        <dl className="grid grid-cols-3 gap-px border-y border-border-base bg-border-base/40">
          {[
            ['Market cap', usdCompact(stats.marketCap)],
            ['24h volume', usdCompact(stats.volume24h)],
            [
              '24h buys / sells',
              stats.buys24h == null && stats.sells24h == null
                ? '—'
                : `${count(stats.buys24h)} / ${count(stats.sells24h)}`,
            ],
          ].map(([label, value]) => (
            <div key={label} className="bg-surface-raised px-3.5 py-2">
              <dt className="text-[10px] uppercase tracking-wide text-fg-subtle">{label}</dt>
              <dd className="mt-0.5 text-xs tabular-nums">{value}</dd>
            </div>
          ))}
        </dl>
      )}

      {degraded && (
        <p className="flex items-start gap-1.5 border-b border-border-base px-3.5 py-2 text-[11px] leading-relaxed text-warning">
          <AlertTriangle size={11} className="mt-0.5 shrink-0" />
          No market data for this token yet. Pools below come from chain state,
          so their depth is unknown.
        </p>
      )}

      <div className="p-3.5">
        <p className="mb-2 text-[10px] uppercase tracking-wide text-fg-subtle">
          {chosen ? 'Trading on' : `Pick a venue (${pools.length})`}
        </p>

        <div className="flex flex-col gap-1.5">
          {pools.map((p) => {
            const isChosen = p.poolId === selectedPoolId;
            const dimmed = !!chosen && !isChosen;
            return (
              <motion.button
                key={p.poolId}
                type="button"
                disabled={busy || spent || dimmed}
                onClick={() => onSelectPool(p.poolId)}
                whileTap={busy ? undefined : { scale: 0.99 }}
                animate={{ opacity: dimmed ? 0.35 : 1 }}
                className={cn(
                  'flex w-full items-center justify-between gap-3 rounded-lg border px-3 py-2 text-left transition-colors',
                  isChosen
                    ? 'border-accent/70 bg-accent/10'
                    : 'border-border-base hover:border-border-strong',
                  dimmed && 'pointer-events-none',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60',
                )}
              >
                <span className="min-w-0">
                  <span className="text-sm font-medium">
                    {token.symbol}/{p.quoteSymbol}
                  </span>
                  {p.collapsed > 0 && (
                    <span className="ml-2 text-[10px] text-fg-subtle">
                      +{p.collapsed} smaller
                    </span>
                  )}
                </span>
                <span className="shrink-0 text-right">
                  <span className="block text-xs tabular-nums text-fg-muted">
                    {p.liquidityUsd > 0 ? `${usdCompact(p.liquidityUsd)} liq` : '—'}
                  </span>
                </span>
              </motion.button>
            );
          })}
        </div>

        {chosen && !spent && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            transition={{ duration: 0.2 }}
            className="mt-3 overflow-hidden"
          >
            {/*
              A sell is sized in the token, a buy in the pool's other asset. This
              label used to say "Amount to spend … USDG" on sells too, while the
              backend read the number as tokens.
            */}
            <div className="mb-1.5 flex items-baseline justify-between gap-2">
              <label className="text-[10px] uppercase tracking-wide text-fg-subtle">
                {selling ? `How much ${token.symbol} to sell` : 'Amount to spend'}
              </label>
              {available && (
                <span className="truncate text-[11px] tabular-nums text-fg-subtle">
                  You have {available.amount} {available.symbol}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <div className="flex flex-1 items-center rounded-lg border border-border-base bg-surface px-3 focus-within:border-border-strong">
                <input
                  ref={amountRef}
                  type="text"
                  inputMode="decimal"
                  value={amount}
                  disabled={busy}
                  placeholder="0.0"
                  onChange={(e) => {
                    // Keep it to a number without fighting the user mid-typing.
                    const v = e.target.value;
                    if (v === '' || /^\d*\.?\d*$/.test(v)) setAmount(v);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { e.preventDefault(); submit(); }
                  }}
                  className="min-w-0 flex-1 bg-transparent py-2 text-sm tabular-nums placeholder:text-fg-subtle focus:outline-none disabled:opacity-50"
                />
                <span className="shrink-0 pl-2 text-xs font-medium text-fg-muted">
                  {selling ? token.symbol : chosen.quoteSymbol}
                </span>
              </div>
              <button
                type="button"
                onClick={submit}
                disabled={busy || !amount || Number(amount) <= 0}
                className={cn(
                  'inline-flex shrink-0 items-center gap-1 rounded-lg px-3.5 py-2 text-sm font-medium transition-colors',
                  'bg-accent text-accent-fg hover:opacity-90',
                  'disabled:cursor-not-allowed disabled:bg-border-base disabled:text-fg-subtle',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60',
                )}
              >
                Get quote
                <ArrowUpRight size={13} />
              </button>
            </div>
            {onSubmitPercent && available && Number(available.amount) > 0 && (
              <div className="mt-2 flex gap-1.5" role="group" aria-label={selling ? 'Sell a share of what you hold' : 'Spend a share of what you hold'}>
                {SHARES.map(([pct, label]) => (
                  <button
                    key={pct}
                    type="button"
                    disabled={busy}
                    onClick={() => onSubmitPercent(pct)}
                    title={`${selling ? 'Sell' : 'Spend'} ${pct}% of your ${available.symbol}`}
                    className="min-h-8 flex-1 rounded-md border border-border-base text-xs font-medium tabular-nums text-fg-muted transition-colors hover:border-border-strong hover:text-fg disabled:opacity-40"
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
          </motion.div>
        )}
      </div>
    </motion.div>
  );
}
