'use client';

import { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { ArrowUpRight, Check, Copy } from 'lucide-react';
import { api } from '@/lib/api';
import { cn, shortAddress } from '@/lib/utils';
import type { HolderKind, HoldersStatus } from '@/lib/types';

/**
 * Plain words for each kind of holder. The people using this are not reading
 * contract addresses for a living; "Liquidity pool — tokens set aside for
 * trading, not a person" is the whole point of labelling at all.
 */
export const KIND: Record<HolderKind, { label: string; hint: string; tone: string }> = {
  wallet: {
    label: 'Wallet',
    hint: 'A person (or a bot) holding the token.',
    tone: 'bg-fg/10 text-fg',
  },
  pool: {
    label: 'Liquidity pool',
    hint: 'Tokens set aside so people can trade. Not a person.',
    tone: 'bg-sky-400/15 text-sky-300',
  },
  burn: {
    label: 'Burned',
    hint: 'Sent to an address nobody controls. Gone for good.',
    tone: 'bg-negative/15 text-negative',
  },
  token: {
    label: 'Token contract',
    hint: 'Held by the token’s own contract, often not released yet.',
    tone: 'bg-amber-400/15 text-amber-300',
  },
  contract: {
    label: 'Contract',
    hint: 'A program rather than a person — e.g. a locker, vesting or launchpad.',
    tone: 'bg-amber-400/15 text-amber-300',
  },
};

export function KindBadge({ kind, name }: { kind: HolderKind; name?: string | null }) {
  const k = KIND[kind];
  return (
    <span
      title={`${name ?? k.label}: ${k.hint}`}
      className={cn('shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium leading-none', k.tone)}
    >
      {name ?? k.label}
    </span>
  );
}

/** An address you can read, copy and check — without having to understand it. */
export function AddressChip({
  address,
  explorer,
  kind = 'address',
  className,
}: {
  address: string;
  explorer?: string;
  kind?: 'address' | 'token';
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-0.5', className)}>
      <code className="truncate font-mono text-[11px] text-fg-muted">{shortAddress(address)}</code>
      <button
        type="button"
        onClick={async (e) => {
          e.stopPropagation();
          try {
            await navigator.clipboard.writeText(address);
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          } catch {
            /* clipboard blocked; the explorer link still works */
          }
        }}
        aria-label={copied ? 'Copied' : 'Copy address'}
        title="Copy address"
        className="grid h-6 w-6 shrink-0 place-items-center rounded text-fg-subtle hover:bg-border-base hover:text-fg"
      >
        {copied ? <Check size={11} className="text-positive" /> : <Copy size={11} />}
      </button>
      {explorer && (
        <a
          href={`${explorer}/${kind === 'token' ? 'token' : 'address'}/${address}`}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          aria-label="Open in block explorer"
          title="Open in block explorer"
          className="grid h-6 w-6 shrink-0 place-items-center rounded text-fg-subtle hover:bg-border-base hover:text-fg"
        >
          <ArrowUpRight size={11} />
        </a>
      )}
    </span>
  );
}

export function TokenAvatar({
  symbol,
  imageUrl,
  size = 'md',
}: {
  symbol: string;
  imageUrl: string | null;
  size?: 'sm' | 'md' | 'lg';
}) {
  // Logos are third-party URLs and fail often; a broken image is replaced by
  // initials rather than left as an empty circle.
  const [broken, setBroken] = useState(false);
  const box = size === 'lg' ? 'h-10 w-10' : size === 'sm' ? 'h-6 w-6' : 'h-8 w-8';
  if (imageUrl && !broken) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={imageUrl}
        alt=""
        onError={() => setBroken(true)}
        className={cn(box, 'shrink-0 rounded-full bg-border-base object-cover')}
      />
    );
  }
  return (
    <div
      className={cn(
        box,
        'grid shrink-0 place-items-center rounded-full bg-border-base text-[9px] font-semibold text-fg-muted',
      )}
    >
      {(symbol || '?').slice(0, 3).toUpperCase()}
    </div>
  );
}

/** A labelled figure. Null renders as a dash, never as zero. */
export function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-0 rounded-lg bg-surface px-3 py-2" title={hint}>
      <p className="truncate text-[10px] uppercase tracking-wide text-fg-subtle">{label}</p>
      <p className="mt-0.5 truncate text-sm font-medium tabular-nums">{value}</p>
    </div>
  );
}

export function SectionTitle({ children, aside }: { children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <div className="mb-2 flex items-baseline justify-between gap-3">
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">{children}</h3>
      {aside}
    </div>
  );
}

/**
 * "Still counting" with a bar that moves. Early history is the busiest part
 * of a token's life, so progress starts slow and speeds up — the copy says
 * "about" for that reason.
 */
export function CountingBar({ progress, status }: { progress: number; status: HoldersStatus }) {
  const queued = status === 'queued' || status === 'not_indexed';
  return (
    <div className="rounded-lg bg-surface px-3 py-2.5">
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <span className="text-fg-muted">
          {queued ? 'Waiting to count holders…' : 'Counting holders from the chain…'}
        </span>
        {!queued && (
          <span className="tabular-nums text-fg-subtle">
            {progress < 1 ? 'starting' : `about ${Math.round(progress)}%`}
          </span>
        )}
      </div>
      <div className="mt-2 h-1 overflow-hidden rounded-full bg-border-base">
        {queued ? (
          <motion.div
            className="h-full w-1/4 rounded-full bg-fg-subtle"
            animate={{ x: ['-100%', '400%'] }}
            transition={{ duration: 1.6, repeat: Infinity, ease: 'easeInOut' }}
          />
        ) : (
          <motion.div
            className="h-full rounded-full bg-fg"
            initial={false}
            animate={{ width: `${Math.max(3, progress)}%` }}
            transition={{ duration: 0.6 }}
          />
        )}
      </div>
      <p className="mt-1.5 text-[11px] text-fg-subtle">
        This updates by itself — you can keep chatting. Busy tokens take a few minutes the first time.
      </p>
    </div>
  );
}

const POLL_MS = 6_000;
/** Give up polling after this long; a stored card should not poll forever. */
const POLL_FOR_MS = 20 * 60_000;

/**
 * Polls indexing progress for tokens that are not ready yet. Stops by itself
 * when all are ready, after twenty minutes, or when the card unmounts.
 */
export function useHolderProgress(tokens: string[], enabled: boolean) {
  const [progress, setProgress] = useState<Record<string, { status: HoldersStatus; progress: number }>>({});
  const key = tokens.join(',');

  useEffect(() => {
    if (!enabled || tokens.length === 0) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const started = Date.now();

    const tick = async () => {
      try {
        const rows = await api.holdersStatus(tokens);
        if (cancelled) return;
        const next = Object.fromEntries(rows.map((r) => [r.address.toLowerCase(), r]));
        setProgress(next);
        if (rows.every((r) => r.status === 'ready')) return;
      } catch {
        /* a failed poll just waits for the next one */
      }
      if (!cancelled && Date.now() - started < POLL_FOR_MS) {
        timer = setTimeout(tick, POLL_MS);
      }
    };
    timer = setTimeout(tick, 1_500);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // `key` stands in for the token list's contents.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled]);

  return progress;
}

export function asOf(iso: string): string {
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function pctOfSupply(p: number | null | undefined): string {
  if (p == null || !Number.isFinite(p)) return '—';
  if (p === 0) return '0%';
  if (p < 0.01) return '<0.01%';
  return `${p < 10 ? p.toFixed(2) : p.toFixed(1)}%`;
}

export function age(firstPoolAt: number | null): string {
  if (firstPoolAt == null) return '—';
  const h = (Date.now() - firstPoolAt) / 3_600_000;
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min`;
  if (h < 48) return `${Math.round(h)} hours`;
  const d = h / 24;
  if (d < 60) return `${Math.round(d)} days`;
  return `${Math.round(d / 30)} months`;
}
