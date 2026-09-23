'use client';

import { motion } from 'motion/react';
import { Copy, Check } from 'lucide-react';
import { useState } from 'react';
import { cn } from '@/lib/utils';
import type { TokenCandidate } from '@/lib/types';

/**
 * The disambiguation card — the interaction the whole product turns on.
 *
 * "Trump" is not a token; it is a name many contracts claim. So the address is
 * shown in full rather than truncated: it is the only thing that actually
 * identifies what you are about to buy, and hiding it behind an ellipsis would
 * be hiding the one field that matters.
 *
 * Selecting sends the opaque candidate id. The address on screen is for the
 * human to read, never for the client to send back.
 */
export function TokenPicker({
  candidates,
  onSelect,
  disabled,
}: {
  candidates: TokenCandidate[];
  onSelect: (candidateId: string) => void;
  disabled?: boolean;
}) {
  const [copied, setCopied] = useState<string | null>(null);

  const copy = async (e: React.MouseEvent, address: string) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(address);
      setCopied(address);
      setTimeout(() => setCopied(null), 1200);
    } catch {
      /* clipboard blocked; the address is visible either way */
    }
  };

  return (
    <div className="mt-3 flex flex-col gap-2">
      {candidates.map((c, i) => (
        <motion.button
          key={c.id}
          type="button"
          disabled={disabled}
          onClick={() => onSelect(c.id)}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: i * 0.04, duration: 0.2, ease: 'easeOut' }}
          whileHover={disabled ? undefined : { y: -1 }}
          className={cn(
            'group w-full rounded-xl border border-border-base bg-surface-raised',
            'px-3.5 py-3 text-left transition-colors',
            'hover:border-accent/60 focus-visible:outline-none',
            'focus-visible:ring-2 focus-visible:ring-accent/60',
            disabled && 'pointer-events-none opacity-50',
          )}
        >
          <div className="flex items-baseline justify-between gap-3">
            <span className="font-semibold tracking-tight">{c.symbol}</span>
            <span className="truncate text-xs text-fg-muted">{c.name}</span>
          </div>

          <div className="mt-2 flex items-center gap-1.5">
            <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-fg-subtle">
              {c.address}
            </code>
            <span
              role="button"
              tabIndex={-1}
              onClick={(e) => copy(e, c.address)}
              className="shrink-0 rounded p-1 text-fg-subtle hover:bg-border-base hover:text-fg"
              aria-label="Copy contract address"
            >
              {copied === c.address ? (
                <Check size={12} className="text-positive" />
              ) : (
                <Copy size={12} />
              )}
            </span>
          </div>

          {c.warnings.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {c.warnings.map((w) => (
                <span
                  key={w}
                  className={cn(
                    'rounded-full px-2 py-0.5 text-[10px] leading-4',
                    w.includes('share this ticker')
                      ? 'bg-warning/12 text-warning'
                      : 'bg-border-base text-fg-muted',
                  )}
                >
                  {w}
                </span>
              ))}
            </div>
          )}
        </motion.button>
      ))}
    </div>
  );
}
