'use client';

import { useCallback, useEffect, useState } from 'react';
import { FlaskConical, Plus } from 'lucide-react';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { changeTone, pctSigned, usdExact, usdSigned } from '@/lib/format';
import type { Portfolio } from '@/lib/types';

const POLL_MS = 30_000;

/**
 * The strip that says, on every screen, that this is not real money.
 *
 * Amber and always visible in sandbox, because the one mistake that matters
 * is someone believing a paper trade was real, or a real one was paper.
 */
export function SandboxBar({
  refreshKey,
  onAddFunds,
}: {
  /** Bump to reload after a trade or a deposit. */
  refreshKey: number;
  onAddFunds: () => void;
}) {
  const [data, setData] = useState<Portfolio | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api.sandbox());
    } catch {
      /* keep the last good figures */
    }
  }, []);

  useEffect(() => {
    // First load on the next tick, then on the interval.
    const first = setTimeout(load, 0);
    const t = setInterval(load, POLL_MS);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [load, refreshKey]);

  const empty = data != null && data.holdings.length === 0;
  const ret = data?.totalReturnUsd ?? null;

  return (
    <div className="flex min-h-9 flex-wrap items-center gap-x-4 gap-y-1 border-b border-amber-400/20 bg-amber-400/[0.07] px-4 py-1.5 text-[11px] sm:px-6">
      <span className="inline-flex items-center gap-1.5 font-medium text-amber-300">
        <FlaskConical size={12} aria-hidden="true" />
        Sandbox
      </span>
      <span className="text-fg-muted">
        {empty ? 'Paper money at real mainnet prices. Add some to start trading.' : 'Paper money, real mainnet prices.'}
      </span>

      {data && !empty && (
        <span className="tabular-nums text-fg-muted">
          Balance <span className="font-medium text-fg">{usdExact(data.totalUsd)}</span>
          {ret != null && (
            <>
              {' · '}Return{' '}
              <span className={cn('font-medium', changeTone(ret))}>
                {usdSigned(ret)}
                {data.totalReturnPct != null && ` (${pctSigned(data.totalReturnPct)})`}
              </span>
            </>
          )}
        </span>
      )}

      <button
        type="button"
        onClick={onAddFunds}
        className={cn(
          'ml-auto inline-flex min-h-7 items-center gap-1 rounded-md px-2.5 font-medium transition-colors',
          empty
            ? 'bg-amber-400 text-bg hover:opacity-90'
            : 'border border-amber-400/30 text-amber-300 hover:bg-amber-400/10',
        )}
      >
        <Plus size={12} aria-hidden="true" />
        Add funds
      </button>
    </div>
  );
}
