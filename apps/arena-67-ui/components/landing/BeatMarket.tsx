'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ConfirmCard } from '@/components/chat/ConfirmCard';
import { Reveal } from './Reveal';

const QUOTE_TTL_MS = 30_000;

/** Shown on the paper page; the card itself renders in the desk's dark theme. */
const sample = {
  action: 'buy',
  token: 'ANIME',
  contract: '0x5fc5…1d68',
  spend: '25 USDG',
  receive: '≈ 1,240 ANIME',
  guaranteedMinimum: '≈ 1,190 ANIME',
  poolFee: '0.3%',
};

export function BeatMarket() {
  const router = useRouter();
  /** Remounts the card so its ring restarts instead of going stale forever. */
  const [cycle, setCycle] = useState(0);

  useEffect(() => {
    const t = setInterval(() => setCycle((c) => c + 1), QUOTE_TTL_MS);
    return () => clearInterval(t);
  }, []);

  const rails = [
    {
      value: '30s',
      label: 'quote lifetime',
      note: 'Quotes expire on a timer; a stale quote is never executed.',
    },
    {
      value: '300',
      label: 'bps slippage floor',
      note: 'A guaranteed minimum is enforced on-chain, not estimated.',
    },
    {
      value: '$25',
      label: 'per-trade cap',
      note: 'No single trade clears the USD cap, whatever the interface asks for.',
    },
  ];

  return (
    <section id="beat" className="border-b border-line bg-paper">
      <div className="mx-auto grid max-w-6xl gap-14 px-5 py-28 sm:px-8 lg:grid-cols-2 lg:items-center lg:gap-20">
        <div className="lg:order-2">
          <Reveal>
            <h2 className="font-display text-4xl font-bold tracking-tight text-ink md:text-5xl">
              Beat your market.
            </h2>
            <p className="mt-6 max-w-[46ch] text-lg leading-relaxed text-ink-muted">
              Quotes are priced before anything is signed, capped before anything
              is sized, and shown to you as a number you either accept or let
              die. Speed is the point; blind trust is not.
            </p>
          </Reveal>

          <Reveal delay={0.1} className="mt-12 space-y-9">
            {rails.map((r) => (
              <div key={r.label} className="flex items-baseline gap-6">
                <span className="w-20 shrink-0 font-ticker text-2xl font-medium tabular-nums text-ink">
                  {r.value}
                </span>
                <div>
                  <p className="font-ticker text-[11px] uppercase tracking-[0.18em] text-ink-subtle">
                    {r.label}
                  </p>
                  <p className="mt-1 max-w-[38ch] text-sm leading-relaxed text-ink-muted">
                    {r.note}
                  </p>
                </div>
              </div>
            ))}
          </Reveal>
        </div>

        <div className="lg:order-1">
          <Reveal delay={0.06}>
            <div className="rounded-2xl border border-ink/10 bg-surface p-5 shadow-2xl shadow-ink/10">
              <div className="mb-4 flex items-center justify-between">
                <span className="font-ticker text-[10px] uppercase tracking-[0.2em] text-fg-subtle">
                  live quote
                </span>
                <span className="font-ticker text-[10px] uppercase tracking-[0.14em] text-fg-subtle">
                  sample
                </span>
              </div>
              <ConfirmCard
                key={cycle}
                summary={sample}
                onConfirm={() => router.push('/dashboard')}
                onRequote={() => router.push('/dashboard')}
              />
            </div>
            <p className="mt-3 px-1 font-ticker text-[11px] leading-relaxed text-ink-subtle">
              A sample quote with a live 30-second timer. The ring is real; the
              numbers are not.
            </p>
          </Reveal>
        </div>
      </div>
    </section>
  );
}