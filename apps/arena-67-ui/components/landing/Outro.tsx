'use client';

import Link from 'next/link';
import { Reveal } from './Reveal';

export function Outro() {
  return (
    <>
      <section className="bg-paper">
        <div className="mx-auto max-w-6xl px-5 py-36 sm:px-8">
          <Reveal className="flex flex-col items-start">
            <h2 className="max-w-3xl font-display text-5xl font-bold leading-[1.02] tracking-tighter text-ink md:text-6xl">
              Step into the arena.
            </h2>
            <p className="mt-6 max-w-[40ch] text-lg leading-relaxed text-ink-muted">
              The desk is live on Robinhood Chain. Paint the market, beat it,
              and keep the keys.
            </p>
            <Link
              href="/dashboard"
              className="mt-10 inline-flex items-center gap-2.5 rounded-xl bg-ink px-6 py-3.5 text-base font-medium text-paper transition-all hover:bg-ink/85 active:scale-[0.98]"
            >
              Open Dashboard
            </Link>
          </Reveal>
        </div>
      </section>

      <footer className="border-t border-line bg-paper">
        <div className="mx-auto flex max-w-6xl flex-col gap-3 px-5 py-8 sm:flex-row sm:items-center sm:justify-between sm:px-8">
          <span className="font-ticker text-[11px] uppercase tracking-[0.18em] text-ink-subtle">
            Games · Robinhood Chain · Uniswap v4
          </span>
          <span className="font-ticker text-[11px] uppercase tracking-[0.18em] text-ink-subtle">
            Built for the OpenServ SERV hackathon · 2026
          </span>
        </div>
      </footer>
    </>
  );
}