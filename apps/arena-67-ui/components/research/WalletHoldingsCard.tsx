'use client';

import { motion } from 'motion/react';
import { ChevronRight } from 'lucide-react';
import { usd, usdCompact } from '@/lib/format';
import type { WalletHoldings } from '@/lib/types';
import { AddressChip, KindBadge, asOf, pctOfSupply } from './shared';

/**
 * What another address holds — the follow-up to "who is this wallet" from a
 * holder list. Only tokens the desk has counted holders for can appear, and
 * the footer says so, so an empty list is not mistaken for an empty wallet.
 */
export function WalletHoldingsCard({
  data,
  onPickToken,
  disabled,
}: {
  data: WalletHoldings;
  onPickToken: (address: string, symbol: string) => void;
  disabled?: boolean;
}) {
  const total = data.holdings.reduce((s, h) => s + (h.valueUsd ?? 0), 0);
  const priced = data.holdings.some((h) => h.valueUsd != null);

  return (
    <motion.article
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="mt-3 overflow-hidden rounded-xl border border-border-base bg-surface-raised"
    >
      <header className="flex items-start justify-between gap-3 px-4 pb-3 pt-3.5">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <AddressChip address={data.address} explorer={data.explorer} />
            <KindBadge kind={data.label} name={data.labelName} />
          </div>
          <p className="mt-0.5 text-[11px] text-fg-subtle">as of {asOf(data.asOf)}</p>
        </div>
        {priced && (
          <div className="shrink-0 text-right">
            <p className="text-[10px] uppercase tracking-wide text-fg-subtle">Value</p>
            <p className="text-base font-semibold tabular-nums">{usdCompact(total)}</p>
          </div>
        )}
      </header>

      {data.holdings.length === 0 ? (
        <p className="border-t border-border-base px-4 py-4 text-sm text-fg-muted">
          This address holds none of the tokens the desk is tracking.
        </p>
      ) : (
        <ul className="divide-y divide-border-base/60 border-t border-border-base">
          {data.holdings.map((h) => (
            <li key={h.token}>
              <button
                type="button"
                disabled={disabled}
                onClick={() => onPickToken(h.token, h.symbol)}
                className="group flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-surface disabled:opacity-50"
                aria-label={`Open report on ${h.symbol}`}
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{h.symbol}</p>
                  <p className="truncate text-[11px] tabular-nums text-fg-subtle">
                    {Number(h.balance).toLocaleString(undefined, { maximumFractionDigits: 2 })} ·{' '}
                    {pctOfSupply(h.percent)} of supply
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="text-sm tabular-nums">{h.valueUsd == null ? 'unpriced' : usdCompact(h.valueUsd)}</p>
                  {h.priceUsd != null && <p className="text-[10px] tabular-nums text-fg-subtle">{usd(h.priceUsd)}</p>}
                </div>
                <ChevronRight size={14} className="shrink-0 text-fg-subtle" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <p className="border-t border-border-base px-4 py-2.5 text-[10px] leading-relaxed text-fg-subtle">
        Among the {data.indexedTokens} tokens the desk has counted holders for — not every token on the chain.
      </p>
    </motion.article>
  );
}
