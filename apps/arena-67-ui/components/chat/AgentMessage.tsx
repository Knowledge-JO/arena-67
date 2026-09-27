'use client';

import { motion } from 'motion/react';
import { Wrench, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { RichText } from '@/lib/rich-text';

/**
 * A reply from the desk: what it said, and what it did to find out.
 *
 * The tool list is shown rather than hidden because it is the difference
 * between an assistant asserting a price and one that can point at where the
 * number came from. On a trading screen that provenance is the trustworthy
 * part — a confident sentence with no source behind it is the failure mode.
 */
export function AgentMessage({
  text,
  toolsUsed,
  truncated,
  children,
}: {
  text: string;
  toolsUsed: string[];
  truncated: boolean;
  children?: React.ReactNode;
}) {
  const unique = [...new Set(toolsUsed)];

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22, ease: 'easeOut' }}
      className="max-w-[46rem]"
    >
      <div className="flex gap-3">
        <div className="mt-1 h-6 w-6 shrink-0 rounded-md bg-accent/15 text-center text-[10px] font-semibold leading-6 text-accent">
          67
        </div>

        <div className="min-w-0 flex-1">
          {unique.length > 0 && (
            <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
              <Wrench size={10} className="text-fg-subtle" aria-hidden="true" />
              {unique.map((t) => (
                <span
                  key={t}
                  className="rounded-full bg-border-base px-1.5 py-0.5 font-mono text-[10px] text-fg-subtle"
                >
                  {t}
                </span>
              ))}
            </div>
          )}

          {/*
            Formatted by a tiny hand-written renderer rather than a markdown
            library: model output is untrusted, and building elements
            directly means nothing it writes can become HTML.
          */}
          <div className="text-sm leading-relaxed text-fg">
            <RichText text={text} />
          </div>

          {truncated && (
            <p
              className={cn(
                'mt-2 flex items-start gap-1.5 text-[11px] leading-relaxed',
                'text-warning',
              )}
            >
              <AlertTriangle size={11} className="mt-0.5 shrink-0" />
              I ran out of research steps, so this answer may be incomplete.
            </p>
          )}

          {children}
        </div>
      </div>
    </motion.div>
  );
}
