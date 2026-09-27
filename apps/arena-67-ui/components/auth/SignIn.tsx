'use client';

import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { ArrowRight, Loader2, Mail } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { cn } from '@/lib/utils';
import type { Me } from '@/lib/types';

/**
 * Email, then a code. The same two steps for a new account and a returning one.
 *
 * There is deliberately no "sign up" versus "log in" choice. A separate
 * sign-up screen that says "that email already has an account" tells anyone
 * who types an address whether its owner uses Arena — and on a product that
 * holds wallets, that list is worth stealing. One flow answers identically.
 */
export function SignIn({ onSignedIn }: { onSignedIn: (me: Me, isNewUser: boolean) => void }) {
  const [stage, setStage] = useState<'email' | 'code'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);
  const codeRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  useEffect(() => {
    if (stage === 'code') codeRef.current?.focus();
  }, [stage]);

  const sendCode = async () => {
    if (busy || !email.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.requestCode(email.trim());
      setStage('code');
      setCode('');
      setCooldown(30);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not send a code.');
    } finally {
      setBusy(false);
    }
  };

  const verify = async (value: string) => {
    if (busy || value.length !== 6) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.verifyCode(email.trim(), value);
      onSignedIn({ user: res.user, wallet: res.wallet }, res.isNewUser);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That code did not work.');
      setCode('');
      codeRef.current?.focus();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-dvh place-items-center bg-bg px-4">
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        className="w-full max-w-sm"
      >
        <div className="mb-8">
          <div className="mb-3 inline-grid h-9 w-9 place-items-center rounded-lg bg-accent/15 text-xs font-semibold text-accent">
            67
          </div>
          <h1 className="text-xl font-semibold tracking-tight">Arena 67</h1>
          <p className="mt-1 text-sm text-fg-muted">
            Research and trade memecoins on Robinhood Chain.
          </p>
        </div>

        <AnimatePresence mode="wait">
          {stage === 'email' ? (
            <motion.form
              key="email"
              initial={{ opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 8 }}
              onSubmit={(e) => {
                e.preventDefault();
                void sendCode();
              }}
            >
              <label className="mb-1.5 block text-xs text-fg-muted">Email</label>
              <div className="flex gap-2">
                <input
                  type="email"
                  autoComplete="email"
                  autoFocus
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  className="min-w-0 flex-1 rounded-lg border border-border-base bg-surface px-3 py-2.5 text-sm placeholder:text-fg-subtle focus:border-border-strong focus:outline-none"
                />
                <button
                  type="submit"
                  disabled={busy || !email.trim()}
                  className="grid w-11 shrink-0 place-items-center rounded-lg bg-accent text-accent-fg transition-opacity hover:opacity-90 disabled:opacity-40"
                  aria-label="Send code"
                >
                  {busy ? <Loader2 size={15} className="animate-spin" /> : <ArrowRight size={15} />}
                </button>
              </div>
              <p className="mt-3 text-xs text-fg-subtle">
                New here or returning — same step. We&apos;ll email you a code, and
                create your wallet the first time you sign in.
              </p>
            </motion.form>
          ) : (
            <motion.div
              key="code"
              initial={{ opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 8 }}
            >
              <div className="mb-4 flex items-start gap-2 rounded-lg border border-border-base bg-surface px-3 py-2.5 text-xs text-fg-muted">
                <Mail size={13} className="mt-0.5 shrink-0" />
                <span>
                  Code sent to <span className="text-fg">{email.trim()}</span>. It
                  expires in 10 minutes.
                </span>
              </div>
              <label className="mb-1.5 block text-xs text-fg-muted">6-digit code</label>
              <input
                ref={codeRef}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={code}
                disabled={busy}
                onChange={(e) => {
                  const v = e.target.value.replace(/\D/g, '').slice(0, 6);
                  setCode(v);
                  // Submits on the sixth digit — including a paste of the
                  // whole code — so there is no button to hunt for.
                  if (v.length === 6) void verify(v);
                }}
                className="w-full rounded-lg border border-border-base bg-surface px-3 py-2.5 text-center font-mono text-lg tracking-[0.5em] focus:border-border-strong focus:outline-none disabled:opacity-50"
              />
              <div className="mt-3 flex items-center justify-between text-xs">
                <button
                  type="button"
                  onClick={() => {
                    setStage('email');
                    setError(null);
                  }}
                  className="text-fg-subtle hover:text-fg"
                >
                  Use a different email
                </button>
                <button
                  type="button"
                  disabled={cooldown > 0 || busy}
                  onClick={() => void sendCode()}
                  className="text-fg-subtle hover:text-fg disabled:opacity-50"
                >
                  {cooldown > 0 ? `Resend in ${cooldown}s` : 'Resend code'}
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {error && (
          <p className={cn('mt-4 text-xs text-negative')}>{error}</p>
        )}
      </motion.div>
    </div>
  );
}
