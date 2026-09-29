'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { AnimatePresence, motion } from 'motion/react';
import { ArrowUpRight, LogOut } from 'lucide-react';
import { api, ApiError, SignedOutError } from '@/lib/api';
import { EXAMPLES } from '@/lib/parse-intent';
import { cn } from '@/lib/utils';
import type { AgentReply, ConversationSummary, Entry, Me, StoredMessage, TradeStep, TradingMode } from '@/lib/types';
import { CARD_OWNS_NOTE, StepCard } from '@/components/chat/StepCard';
import { AgentMessage } from '@/components/chat/AgentMessage';
import { Composer, type ComposerHandle } from '@/components/chat/Composer';
import { TrendingPane } from '@/components/research/TrendingPane';
import { SignIn } from '@/components/auth/SignIn';
import { WalletBox } from '@/components/account/WalletBox';
import { ConversationList } from '@/components/account/ConversationList';
import { ModeSwitch } from '@/components/account/ModeSwitch';
import { SandboxBar } from '@/components/account/SandboxBar';
import { AddFundsDialog } from '@/components/account/AddFundsDialog';
import { Logo } from '@/components/brand/Logo';

/** How many of the latest report cards keep their prices live. */
const LIVE_REPORTS = 2;

const uid = () => Math.random().toString(36).slice(2);

/** Stored turns back into transcript entries, so a reopened chat redraws its cards. */
function toEntries(rows: StoredMessage[]): Entry[] {
  return rows.map((m) =>
    m.role === 'user'
      ? { id: m.id, role: 'user' as const, text: m.content }
      : {
          id: m.id,
          role: 'agent' as const,
          text: m.content,
          step: m.step,
          toolsUsed: m.toolsUsed ?? [],
          truncated: false,
        },
  );
}

/**
 * Resolves the session before anything renders. `undefined` means still
 * checking — distinct from `null`, signed out — so the sign-in screen does not
 * flash for a moment on every load of a signed-in user.
 */
export default function Dashboard() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [loadError, setLoadError] = useState(false);

  const loadMe = useCallback(() => {
    void api.me().then(setMe).catch(() => setLoadError(true));
  }, []);

  useEffect(() => {
    loadMe();
  }, [loadMe]);

  if (me === undefined) {
    if (loadError) {
      return (
        <div className="grid h-dvh place-items-center bg-bg px-6 text-center text-fg">
          <div>
            <p className="font-ticker text-xs uppercase tracking-[0.18em] text-fg-subtle">
              Desk unavailable
            </p>
            <p className="mt-3 text-sm text-fg-muted">The dashboard could not reach the trading desk.</p>
            <button
              type="button"
              onClick={() => {
                setLoadError(false);
                loadMe();
              }}
              className="mt-5 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-fg transition-opacity hover:opacity-90"
            >
              Try again
            </button>
          </div>
        </div>
      );
    }
    return <div className="grid h-dvh place-items-center bg-bg text-xs text-fg-subtle">Loading…</div>;
  }
  if (me === null) {
    return <SignIn onSignedIn={(signedIn) => setMe(signedIn)} />;
  }
  return <Arena me={me} onSignedOut={() => setMe(null)} />;
}

function Arena({ me, onSignedOut }: { me: Me; onSignedOut: () => void }) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [mobileView, setMobileView] = useState<'desk' | 'markets' | 'chats'>('desk');
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  /** The open conversation. Null until the first message creates one. */
  const [conversationId, setConversationId] = useState<string | null>(null);
  /** Steps already acted on, so a card can't be replayed after it's used. */
  const [spent, setSpent] = useState<Set<string>>(new Set());
  /** Cards currently being re-priced, so only that one shows a spinner. */
  const [repricing, setRepricing] = useState<Set<string>>(new Set());
  /** Sandbox or live. The server holds the truth; this mirrors it. */
  const [mode, setMode] = useState<TradingMode>(me.mode ?? 'sandbox');
  /** Bumped after trades and deposits so balances on screen reload. */
  const [balanceKey, setBalanceKey] = useState(0);
  const refreshBalances = () => setBalanceKey((k) => k + 1);
  const [addingFunds, setAddingFunds] = useState(false);

  const bottomRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<ComposerHandle>(null);

  const push = (e: Entry) => setEntries((prev) => [...prev, e]);

  /**
   * Any call can discover the session has ended. Rather than showing an error
   * inside a chat that can no longer do anything, hand back to sign-in.
   */
  const fail = useCallback(
    (err: unknown) => {
      if (err instanceof SignedOutError) {
        onSignedOut();
        return;
      }
      push({
        id: uid(),
        role: 'error',
        text: err instanceof ApiError ? err.message : 'Something went wrong talking to the desk.',
      });
    },
    [onSignedOut],
  );

  const refreshConversations = useCallback(async () => {
    try {
      setConversations(await api.conversations());
    } catch (e) {
      fail(e);
    }
  }, [fail]);

  useEffect(() => {
    const t = setTimeout(refreshConversations, 0);
    return () => clearTimeout(t);
  }, [refreshConversations]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [entries]);

  /**
   * One agent turn in the open conversation.
   *
   * The server owns the conversation now: the client sends only the new
   * message and which conversation it belongs to. It used to post its whole
   * transcript back each turn, which let it rewrite what the model believed
   * had been said.
   */
  const ask = useCallback(
    async (text: string): Promise<AgentReply | null> => {
      push({ id: uid(), role: 'user', text });
      setBusy(true);
      try {
        const turn = await api.chat(text, conversationId ?? undefined);
        if (turn.conversationId !== conversationId) {
          setConversationId(turn.conversationId);
          void refreshConversations();
        }
        push({
          id: uid(),
          role: 'agent',
          text: turn.reply,
          step: turn.step,
          toolsUsed: turn.toolsUsed,
          truncated: turn.truncated,
        });
        return turn;
      } catch (e) {
        fail(e);
        return null;
      } finally {
        setBusy(false);
        // A turn may have traded or added paper funds.
        setBalanceKey((k) => k + 1);
      }
    },
    [conversationId, fail, refreshConversations],
  );

  const send = () => {
    const text = draft.trim();
    if (!text || busy) return;
    setDraft('');
    void ask(text);
  };

  /** A pane row carries its address, so the agent gets it and need not guess. */
  const openToken = useCallback(
    (address: string, symbol: string) => {
      setMobileView('desk');
      void ask(`Tell me about ${symbol} (${address})`);
    },
    [ask],
  );

  /**
   * The wallet box asks the agent rather than opening a screen, so the
   * portfolio lands in this conversation as a card — something that can be
   * scrolled back to and discussed, which a modal cannot.
   */
  const openPortfolio = async () => {
    if (busy) return;
    setMobileView('desk');
    const turn = await ask('Show my portfolio');
    // The button must always end in the card. If the agent could not draw it —
    // out of credits, offline, or it answered without the tool — fetch the
    // portfolio directly and show it here.
    if (turn?.step?.kind === 'portfolio') return;
    try {
      push({ id: uid(), role: 'card', step: await api.portfolio() });
    } catch (e) {
      fail(e);
    }
  };

  const openConversation = async (id: string) => {
    if (busy || id === conversationId) return;
    setMobileView('desk');
    setBusy(true);
    try {
      setEntries(toEntries(await api.messages(id)));
      setConversationId(id);
      setSpent(new Set());
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const deleteConversation = async (id: string) => {
    if (busy || !window.confirm('Delete this conversation? This cannot be undone.')) return;
    setBusy(true);
    try {
      await api.deleteConversation(id);
      setConversations((current) => current.filter((conversation) => conversation.id !== id));
      if (id === conversationId) {
        setConversationId(null);
        setEntries([]);
        setSpent(new Set());
      }
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const newConversation = () => {
    if (busy) return;
    // Created lazily by the first message, so an abandoned "new" leaves no
    // empty conversation behind in the list.
    setConversationId(null);
    setEntries([]);
    setSpent(new Set());
    setMobileView('desk');
    composerRef.current?.focus();
  };

  const signOut = async () => {
    await api.logout().catch(() => undefined);
    onSignedOut();
  };

  /** A step produced by acting on a card, rather than by asking the agent. */
  const land = (step: TradeStep) => {
    push({ id: uid(), role: 'card', step });
    refreshBalances();
  };

  /**
   * Flips the mode on the server, then here. A note goes into the transcript
   * so cards above and below it read in context.
   */
  const switchMode = async (next: TradingMode) => {
    try {
      const r = await api.setMode(next);
      setMode(r.mode);
      push({
        id: uid(),
        role: 'notice',
        text: r.mode === 'sandbox' ? 'Switched to Sandbox — paper money from here on.' : 'Switched to Live — trades now use real money.',
      });
      refreshBalances();
    } catch (e) {
      fail(e);
    }
  };

  /** Runs a step without retiring the card it came from. */
  const run = async (work: () => Promise<TradeStep>) => {
    if (busy) return;
    setBusy(true);
    try {
      land(await work());
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  /**
   * Re-pricing replaces a card's price rather than adding a rung to the
   * ladder, so the spinner is keyed to the card that asked for it.
   */
  const requote = async (cardKey: string, intentId: string) => {
    if (busy) return;
    setBusy(true);
    setRepricing((s) => new Set(s).add(cardKey));
    try {
      land(await api.requote(intentId));
    } catch (e) {
      fail(e);
    } finally {
      setRepricing((s) => {
        const n = new Set(s);
        n.delete(cardKey);
        return n;
      });
      setBusy(false);
    }
  };

  const act = async (key: string, work: () => Promise<TradeStep>) => {
    if (busy) return;
    setBusy(true);
    setSpent((s) => new Set(s).add(key));
    try {
      land(await work());
    } catch (e) {
      // Let the card work again — a network blip shouldn't strand the trade.
      setSpent((s) => {
        const n = new Set(s);
        n.delete(key);
        return n;
      });
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  /**
   * The two most recent report cards update live; older ones stay snapshots.
   * Two, not all: every live card polls the chain, and a long conversation
   * about ten tokens should not keep ten polls running for cards scrolled
   * far out of view.
   */
  const liveReports = useMemo(() => {
    const ids = new Set<string>();
    let reports = 0;
    let portfolio = false;
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e.role !== 'agent' && e.role !== 'card') continue;
      if (e.step?.kind === 'token_report' && reports < LIVE_REPORTS) {
        ids.add(e.id);
        reports += 1;
      }
      // One live portfolio card — the latest. Older ones are the record of
      // their moment, and two live copies of the same account say nothing new.
      if (e.step?.kind === 'portfolio' && !portfolio) {
        ids.add(e.id);
        portfolio = true;
      }
    }
    return ids;
  }, [entries]);

  /** Every card handler, keyed to the entry that drew the card. */
  const cardProps = (entryId: string, step: TradeStep) => ({
    step,
    live: liveReports.has(entryId),
    busy,
    spent: 'intentId' in step ? spent.has(`${entryId}:${step.intentId}`) : false,
    repricing: repricing.has(entryId),
    onSelectPool: (intentId: string, poolId: string) =>
      // Not marked spent: the card stays live so the amount input can open on
      // it and the venue can be changed before a price is requested.
      void run(() => api.selectPool(intentId, poolId)),
    onSubmitAmount: (intentId: string, amount: number) =>
      act(`${entryId}:${intentId}`, () => api.setAmount(intentId, amount)),
    onSubmitPercent: (intentId: string, percent: number) =>
      act(`${entryId}:${intentId}`, () => api.setPercent(intentId, percent)),
    onRequote: (intentId: string) => void requote(entryId, intentId),
    onPickToken: openToken,
    onAddFunds: () => setAddingFunds(true),
    onAsk: (text: string) => {
      if (busy) return;
      setMobileView('desk');
      void ask(text);
    },
    onBuy: (address: string, symbol: string) => {
      if (busy) return;
      void ask(`Buy ${symbol} (${address})`);
    },
    onSell: (address: string, symbol: string) => {
      if (busy) return;
      void ask(`Sell ${symbol} (${address})`);
    },
    onSelectToken: (intentId: string, candidateId: string) =>
      act(`${entryId}:${intentId}`, () => api.selectToken(intentId, candidateId)),
    onConfirm: (intentId: string, quoteId: string) =>
      act(`${entryId}:${intentId}`, () => api.confirm(intentId, quoteId)),
  });

  return (
    <div className="grid h-dvh grid-cols-1 grid-rows-[auto_auto_minmax(0,1fr)] bg-bg font-display text-fg lg:grid-cols-[15rem_minmax(0,1fr)_20rem] lg:grid-rows-[auto_minmax(0,1fr)]">
      <div className="col-span-full">
      <header className="flex min-h-14 items-center gap-2 border-b border-border-base px-3 py-3 sm:gap-3 sm:px-6">
        <Link
          href="/"
          aria-label="Arena 67 home"
          className="text-fg transition-colors hover:text-fg-muted"
        >
          <Logo />
        </Link>
        <span className="hidden h-4 w-px bg-border-strong md:block" aria-hidden="true" />
        <span className="hidden font-ticker text-[10px] uppercase tracking-[0.12em] text-fg-subtle md:inline">
          Robinhood Chain
        </span>

        <div className="ml-auto flex min-w-0 items-center gap-1 sm:gap-2">
          <ModeSwitch mode={mode} walletAddress={me.wallet.address} onChange={switchMode} disabled={busy} />
          <WalletBox onOpenPortfolio={openPortfolio} disabled={busy} mode={mode} refreshKey={balanceKey} />
          <button
            type="button"
            onClick={signOut}
            title={`Sign out ${me.user.email ?? ''}`}
            aria-label="Sign out"
            className="grid h-8 w-8 place-items-center rounded-lg text-fg-subtle transition-colors hover:bg-surface-raised hover:text-fg"
          >
            <LogOut size={14} />
          </button>
        </div>
      </header>
      {mode === 'sandbox' && <SandboxBar refreshKey={balanceKey} onAddFunds={() => setAddingFunds(true)} />}
      </div>

      <AnimatePresence>
        {addingFunds && (
          <AddFundsDialog
            onClose={() => setAddingFunds(false)}
            onDone={(note) => {
              setAddingFunds(false);
              push({ id: uid(), role: 'notice', text: note });
              refreshBalances();
            }}
          />
        )}
      </AnimatePresence>

      <nav
        aria-label="Workspace views"
        className="grid grid-cols-3 border-b border-border-base bg-surface/50 lg:hidden"
      >
        {(
          [
            ['chats', 'History'],
            ['desk', 'Chat'],
            ['markets', 'Markets'],
          ] as const
        ).map(([view, label]) => (
          <button
            key={view}
            type="button"
            aria-pressed={mobileView === view}
            onClick={() => setMobileView(view)}
            className={cn(
              'border-b-2 px-4 py-3 text-xs font-medium transition-colors',
              mobileView === view
                ? 'border-fg text-fg'
                : 'border-transparent text-fg-subtle hover:text-fg-muted',
            )}
          >
            {label}
          </button>
        ))}
      </nav>

      <aside
        className={cn(
          'min-h-0 flex-col border-border-base bg-surface/30 lg:flex lg:border-r',
          mobileView === 'chats' ? 'flex' : 'hidden',
        )}
      >
        <ConversationList
          conversations={conversations}
          activeId={conversationId}
          onSelect={(id) => void openConversation(id)}
          onNew={newConversation}
          onDelete={(id) => void deleteConversation(id)}
          disabled={busy}
        />
      </aside>

      <main
        id="desk-panel"
        className={cn('min-h-0 flex-col', mobileView === 'desk' ? 'flex' : 'hidden', 'lg:flex')}
      >
        <div className="flex min-h-12 items-center justify-between border-b border-border-base/70 px-4 sm:px-6">
          <div>
            <h1 className="text-xs font-semibold tracking-wide">Research &amp; trade</h1>
            <p className="mt-0.5 text-[10px] text-fg-subtle">
              Ask about any token, then trade it. Nothing is signed until you confirm.
            </p>
          </div>
          <span className="hidden font-ticker text-[9px] uppercase tracking-[0.14em] text-fg-subtle sm:inline">
            Research <span aria-hidden="true">→</span> Quote <span aria-hidden="true">→</span> Confirm
          </span>
        </div>
        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6">
          <div className="mx-auto flex max-w-3xl flex-col gap-5">
            {entries.length === 0 && (
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="pt-[10vh]">
                <p className="font-ticker text-[10px] uppercase tracking-[0.22em] text-fg-subtle">
                  Start here
                </p>
                <h2 className="mt-4 max-w-2xl text-3xl font-semibold leading-[1.08] tracking-[-0.045em] sm:text-4xl">
                  Make your next move.
                </h2>
                <p className="mt-3 max-w-md text-sm leading-relaxed text-fg-muted">
                  Ask about any token and get a full report — price, risks, and who
                  holds it. Find what&apos;s trading, spot wallets holding several tokens,
                  and trade when you&apos;re ready. Nothing is signed until you confirm.
                </p>
                <div className="mt-7">
                  <p className="mb-2.5 font-ticker text-[9px] uppercase tracking-[0.16em] text-fg-subtle">
                    Try
                  </p>
                  <div className="grid max-w-xl gap-2 sm:grid-cols-2">
                    {EXAMPLES.map((ex) => (
                      <button
                        key={ex}
                        type="button"
                        onClick={() => void ask(ex)}
                        className="group flex min-h-11 items-center justify-between gap-3 rounded-lg border border-border-base bg-surface px-3.5 py-2.5 text-left text-xs text-fg-muted transition-colors hover:border-border-strong hover:bg-surface-raised hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
                      >
                        <span>{ex}</span>
                        <ArrowUpRight
                          size={13}
                          className="shrink-0 text-fg-subtle transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5"
                          aria-hidden="true"
                        />
                      </button>
                    ))}
                  </div>
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
                ) : e.role === 'notice' ? (
                  <motion.p
                    key={e.id}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="self-center rounded-full border border-border-base px-3 py-1 text-[11px] text-fg-subtle"
                  >
                    {e.text}
                  </motion.p>
                ) : e.role === 'error' ? (
                  <motion.p
                    key={e.id}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="text-sm text-negative"
                  >
                    {e.text}
                  </motion.p>
                ) : e.role === 'agent' ? (
                  <AgentMessage
                    key={e.id}
                    text={e.text}
                    toolsUsed={e.toolsUsed}
                    truncated={e.truncated}
                    hideText={!!e.step && CARD_OWNS_NOTE.has(e.step.kind)}
                  >
                    {/* Research and portfolio cards carry the agent's comment
                        inside them; trade cards keep it above as the prompt. */}
                    {e.step && (
                      <StepCard
                        {...cardProps(e.id, e.step)}
                        note={CARD_OWNS_NOTE.has(e.step.kind) ? e.text : undefined}
                        bare
                      />
                    )}
                  </AgentMessage>
                ) : (
                  <StepCard key={e.id} {...cardProps(e.id, e.step)} />
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
              placeholder="Ask about a token, its holders, or a trade"
            />
            <p className="mt-2 flex items-center justify-between gap-3 font-ticker text-[9px] uppercase tracking-[0.1em] text-fg-subtle">
              <span>Nothing is signed until you confirm a quote.</span>
              <Link href="/" className="inline-flex shrink-0 items-center gap-1 transition-colors hover:text-fg">
                Home <ArrowUpRight size={11} aria-hidden="true" />
              </Link>
            </p>
          </div>
        </div>
      </main>

      <aside
        id="markets-panel"
        className={cn(
          'min-h-0 flex-col border-t border-border-base bg-surface/40 lg:flex lg:border-l lg:border-t-0',
          mobileView === 'markets' ? 'flex' : 'hidden',
        )}
      >
        <TrendingPane onPick={openToken} />
      </aside>
    </div>
  );
}
