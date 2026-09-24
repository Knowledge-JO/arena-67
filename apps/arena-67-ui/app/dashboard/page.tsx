'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Copy, Check } from 'lucide-react';
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
    <div className="grid h-dvh grid-cols-1 lg:grid-cols-[1fr_20rem]">
      <div className="flex min-h-0 flex-col">
        <header className="flex items-center gap-3 border-b border-border-base px-4 py-3 sm:px-6">
          <span className="text-sm font-semibold tracking-tight">Arena 67</span>
          <span className="rounded-full border border-border-base px-2 py-0.5 text-[10px] text-fg-muted">
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
              className="ml-auto inline-flex items-center gap-1.5 rounded-lg px-2 py-1 font-mono text-[11px] text-fg-muted transition-colors hover:bg-surface-raised hover:text-fg"
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
                className="pt-[12vh]"
              >
                <h1 className="text-lg font-medium tracking-tight">
                  What do you want to trade?
                </h1>
                <p className="mt-1.5 max-w-md text-sm leading-relaxed text-fg-muted">
                  Say it plainly. I&apos;ll find the token, price the swap, and
                  show you the fill before anything is signed.
                </p>
                <div className="mt-4 flex flex-wrap gap-1.5">
                  {EXAMPLES.map((ex) => (
                    <button
                      key={ex}
                      type="button"
                      onClick={() => setDraft(ex)}
                      className="rounded-full border border-border-base px-3 py-1.5 text-xs text-fg-muted transition-colors hover:border-border-strong hover:text-fg"
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
            <p className={cn('mt-1.5 text-[10px] text-fg-subtle')}>
              Nothing is signed until you confirm a quote.
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
