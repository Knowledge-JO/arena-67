'use client';

import Link from 'next/link';
import { useTrending } from '@/lib/use-trending';
import { Reveal } from './Reveal';

/**
 * The research act. The copy carries the pitch; the board is the real product:
 * whatever the desk index is serving right now is what renders here.
 */
export function PaintMarket() {
  const { snap, failed } = useTrending();
  const tokens = snap?.tokens ?? null;
  const live = Boolean(snap?.index.ready);

  return (
    <section id="paint" className="border-b border-line bg-paper">
      <div className="mx-auto grid max-w-6xl gap-14 px-5 py-28 sm:px-8 lg:grid-cols-[1fr_1fr] lg:gap-20">
        <div>
          <Reveal>
            <h2 className="font-display text-4xl font-bold tracking-tight text-ink md:text-5xl">
              Paint your market.
            </h2>
            <p className="mt-6 max-w-[46ch] text-lg leading-relaxed text-ink-muted">
              Every Uniswap v4 pool on Robinhood Chain is indexed and watched.
              Trending tickers and the narratives forming around them surface
              first, so you know what the room is talking about before you size
              a position.
            </p>
          </Reveal>

          <Reveal delay={0.1} className="mt-12">
            <div className="flex gap-12">
              <div>
                <p className="font-ticker text-3xl font-medium tabular-nums text-ink">
                  {live ? snap?.index.pools.toLocaleString() : '−'}
                </p>
                <p className="mt-1.5 font-ticker text-[11px] uppercase tracking-[0.18em] text-ink-subtle">
                  pools indexed
                </p>
              </div>
              <div>
                <p className="font-ticker text-3xl font-medium tabular-nums text-ink">
                  {live ? snap?.index.tokens.toLocaleString() : '−'}
                </p>
                <p className="mt-1.5 font-ticker text-[11px] uppercase tracking-[0.18em] text-ink-subtle">
                  tokens watched
                </p>
              </div>
            </div>
          </Reveal>
        </div>

        <div>
          <Reveal delay={0.08}>
            <div className="overflow-hidden rounded-2xl border border-line bg-paper-sunk">
              <div className="flex items-center justify-between border-b border-line px-6 py-4">
                <span className="font-ticker text-[11px] uppercase tracking-[0.2em] text-ink">
                  Trending now
                </span>
                <span className="font-ticker text-[11px] uppercase tracking-[0.14em] text-ink-subtle">
                  {live ? 'live index' : 'offline'}
                </span>
              </div>

              {!failed && !tokens && (
                <div className="space-y-1 px-6 py-5" aria-hidden>
                  {Array.from({ length: 6 }).map((_, i) => (
                    <div
                      key={i}
                      className="h-9 animate-pulse rounded-lg bg-line/60"
                    />
                  ))}
                </div>
              )}

              {failed && (
                <div className="px-6 py-10">
                  <p className="text-sm leading-relaxed text-ink-muted">
                    The desk is on :9000, but it is not answering right now.
                    Start the backend and the board fills itself.
                  </p>
                </div>
              )}

              {tokens?.length === 0 && (
                <div className="px-6 py-10">
                  <p className="text-sm leading-relaxed text-ink-muted">
                    No tokens indexed yet.
                  </p>
                </div>
              )}

              {tokens && tokens.length > 0 && (
                <ul className="px-3 py-3">
                  {tokens.slice(0, 6).map((t, i) => (
                    <li key={t.address}>
                      <Link
                        href="/dashboard"
                        className="flex items-baseline justify-between gap-4 rounded-xl px-3 py-3.5 transition-colors hover:bg-paper"
                      >
                        <span className="flex min-w-0 items-baseline gap-3">
                          <span className="w-5 shrink-0 text-right font-ticker text-[11px] text-ink-subtle">
                            {String(i + 1).padStart(2, '0')}
                          </span>
                          <span className="truncate font-display text-base font-semibold text-ink">
                            {t.symbol}
                          </span>
                        </span>
                        <span className="shrink-0 font-ticker text-xs tabular-nums text-ink-muted">
                          {t.poolCount} {t.poolCount === 1 ? 'pool' : 'pools'}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  );
}