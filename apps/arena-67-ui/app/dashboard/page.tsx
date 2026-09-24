'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { AnimatePresence, motion } from 'motion/react';
import { ArrowUpRight, Check, Copy } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { getSessionId } from '@/lib/session';
import { parseIntent, EXAMPLES } from '@/lib/parse-intent';
import { shortAddress, cn } from '@/lib/utils';
import type { Entry, TradeStep } from '@/lib/types';
import { StepCard } from '@/components/chat/StepCard';
import { Composer, type ComposerHandle } from '@/components/chat/Composer';
import { TrendingPane } from '@/components/research/TrendingPane';

const uid = () => Math.random().toString(36).slice(2);

export default function Arena() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [wallet, setWallet] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  /** Steps already acted on, so a card can't be replayed after it's used. */
  const [spent, setSpent] = useState<Set<string>>(new Set());

  const sessionRef = useRef<string>('');
  const bottomRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<ComposerHandle>(null);

  /**
   * Picking a token seeds the composer. Focusing it is what makes that
   * legible: without it the only feedback is text appearing in a textarea in
   * the opposite corner of the screen, which reads as the click doing nothing.
   */
  const pickToken = useCallback((symbol: string) => {
    setDraft(`buy 25 USDG of ${symbol}`);
    requestAnimationFrame(() => composerRef.current?.focus());
  }, []);

  useEffect(() => { sessionRef.current = getSessionId(); }, []);
  useEffect(() => {
    api.wallet().then((w) => setWallet(w.address)).catch(() => setWallet(null));
  }, []);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [entries]);

  const push = (e: Entry) => setEntries((prev) => [...prev, e]);

  /** Single place where a step becomes a transcript entry. */
  const land = useCallback((step: TradeStep) => {
    push({ id: uid(), role: 'agent', step });
  }, []);

  const fail = (err: unknown) =>
    push({
      id: uid(),
      role: 'error',
      text:
        err instanceof ApiError
          ? err.message
          : 'Something went wrong talking to the desk.',
    });

  const send = async () => {
    const text = draft.trim();
    if (!text || busy) return;

    push({ id: uid(), role: 'user', text });
    setDraft('');

    const intent = parseIntent(text);
    if (!intent) {
      push({
        id: uid(),
        role: 'error',
        text: 'Say buy or sell, and which token — for example "buy 25 USDG of ANIME".',
      });
      return;
    }

    setBusy(true);
    try {
      land(await api.begin(sessionRef.current, intent));
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const act = async (key: string, run: () => Promise<TradeStep>) => {
    if (busy) return;
    setBusy(true);
    setSpent((s) => new Set(s).add(key));
    try {
      land(await run());
    } catch (e) {
      // Let the card work again — a network blip shouldn't strand the trade.
      setSpent((s) => { const n = new Set(s); n.delete(key); return n; });
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid h-dvh grid-cols-1 bg-bg font-display text-fg lg:grid-cols-[1fr_20rem]">
      <div className="flex min-h-0 flex-col">
        <header className="flex min-h-14 items-center gap-3 border-b border-border-base px-4 py-3 sm:px-6">
          <Link
            href="/"
            aria-label="Arena 67 home"
            className="flex items-center gap-2 text-xs font-bold tracking-[0.16em] text-fg transition-colors hover:text-fg-muted"
          >
            ARENA
            <span className="grid h-5 w-7 place-items-center border border-border-strong font-ticker text-[10px] font-medium tracking-normal">
              67
            </span>
          </Link>
          <span className="h-4 w-px bg-border-strong" aria-hidden="true" />
          <span className="font-ticker text-[10px] uppercase tracking-[0.12em] text-fg-subtle">
            Robinhood Chain
          </span>

          {wallet && (
            <button
              type="button"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(wallet);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1200);
                } catch { /* clipboard blocked */ }
              }}
              className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-border-base px-2.5 py-1.5 font-mono text-[10px] text-fg-muted transition-colors hover:border-border-strong hover:bg-surface-raised hover:text-fg"
              title="Agent wallet — copy address"
            >
              {shortAddress(wallet)}
              {copied ? <Check size={11} className="text-positive" /> : <Copy size={11} />}
            </button>
          )}
        </header>

        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6">
          <div className="mx-auto flex max-w-3xl flex-col gap-5">
            {entries.length === 0 && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="pt-[10vh]"
              >
                <p className="font-ticker text-[10px] uppercase tracking-[0.22em] text-fg-subtle">
                  Arena 67 / Trading desk
                </p>
                <h1 className="mt-4 max-w-2xl text-3xl font-semibold leading-[1.08] tracking-[-0.045em] sm:text-4xl">
                  What do you want to trade?
                </h1>
                <p className="mt-3 max-w-md text-sm leading-relaxed text-fg-muted">
                  Say it plainly. I&apos;ll find the token, price the swap, and
                  show you the fill before anything is signed.
                </p>
                <div className="mt-6 flex flex-wrap gap-2">
                  {EXAMPLES.map((ex) => (
                    <button
                      key={ex}
                      type="button"
                      onClick={() => setDraft(ex)}
                      className="rounded-lg border border-border-base bg-surface px-3 py-2 text-xs text-fg-muted transition-colors hover:border-border-strong hover:bg-surface-raised hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
                    >
                      {ex}
                    </button>
                  ))}
                </div>
              </motion.div>
            )}

            <AnimatePresence initial={false}>
              {entries.map((e) =>
                e.role === 'user' ? (
                  <motion.div
                    key={e.id}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="self-end rounded-2xl rounded-br-md bg-surface-raised px-3.5 py-2 text-sm"
                  >
                    {e.text}
                  </motion.div>
                ) : e.role === 'error' ? (
                  <motion.p
                    key={e.id}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="text-sm text-negative"
                  >
                    {e.text}
                  </motion.p>
                ) : (
                  <StepCard
                    key={e.id}
                    step={e.step}
                    busy={busy}
                    spent={
                      'intentId' in e.step
                        ? spent.has(`${e.id}:${e.step.intentId}`)
                        : false
                    }
                    onSelectToken={(intentId, candidateId) =>
                      act(`${e.id}:${intentId}`, () =>
                        api.selectToken(sessionRef.current, intentId, candidateId),
                      )
                    }
                    onConfirm={(intentId, quoteId) =>
                      act(`${e.id}:${intentId}`, () =>
                        api.confirm(sessionRef.current, intentId, quoteId),
                      )
                    }
                  />
                ),
              )}
            </AnimatePresence>

            {busy && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="flex items-center gap-1.5 text-xs text-fg-subtle"
              >
                {[0, 1, 2].map((i) => (
                  <motion.span
                    key={i}
                    className="h-1 w-1 rounded-full bg-fg-subtle"
                    animate={{ opacity: [0.25, 1, 0.25] }}
                    transition={{ duration: 1.1, repeat: Infinity, delay: i * 0.15 }}
                  />
                ))}
                <span className="ml-1">working</span>
              </motion.div>
            )}

            <div ref={bottomRef} />
          </div>
        </div>

        <div className="border-t border-border-base px-4 py-3 sm:px-6">
          <div className="mx-auto max-w-3xl">
            <Composer
              ref={composerRef}
              value={draft}
              onChange={setDraft}
              onSend={send}
              busy={busy}
              placeholder='e.g. "buy 25 USDG of ANIME"  ·  press / to focus'
            />
            <p className={cn('mt-2 flex items-center justify-between gap-3 font-ticker text-[9px] uppercase tracking-[0.1em] text-fg-subtle')}>
              <span>Nothing is signed until you confirm a quote.</span>
              <Link href="/" className="inline-flex shrink-0 items-center gap-1 transition-colors hover:text-fg">
                Home <ArrowUpRight size={11} aria-hidden="true" />
              </Link>
            </p>
          </div>
        </div>
      </div>

      <div className="hidden min-h-0 lg:block">
        <TrendingPane onPick={pickToken} />
      </div>
    </div>
  );
}
