'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Composer } from '@/components/chat/Composer';
import { StepCard } from '@/components/chat/StepCard';
import { Reveal } from './Reveal';

export function Product() {
  const router = useRouter();
  const [draft, setDraft] = useState('');

  const features = [
    {
      title: 'One chat',
      body: 'Say what you want to buy or sell. The desk finds the token, prices the swap, and shows you the fill before anything is signed.',
    },
    {
      title: 'One wallet',
      body: 'A TEE-held agent wallet signs on Robinhood Chain. Keys never leave the vault, and every signature goes to a trade you confirmed.',
    },
    {
      title: 'One rule',
      body: 'Nothing broadcasts without your explicit confirmation. The trade is yours until the moment you accept the quote.',
    },
  ];

  return (
    <section id="product" className="border-b border-line bg-paper">
      <div className="mx-auto max-w-6xl px-5 py-28 sm:px-8">
        <Reveal>
          <h2 className="max-w-3xl font-display text-4xl font-bold tracking-tight text-ink md:text-5xl">
            Your product.
          </h2>
          <p className="mt-6 max-w-[52ch] text-lg leading-relaxed text-ink-muted">
            One line of conversation with the arena. The desk in the dark, the
            market on the side, and every trade on the record.
          </p>
        </Reveal>

        <Reveal delay={0.08} className="mt-14">
          <div className="overflow-hidden rounded-2xl border border-ink/10 bg-surface shadow-2xl shadow-ink/10">
            <div className="flex h-11 items-center justify-between border-b border-border-base px-5">
              <span className="font-ticker text-[10px] uppercase tracking-[0.2em] text-fg-subtle">
                arena 67 · the desk
              </span>
              <span className="rounded-full border border-border-base px-2 py-0.5 font-ticker text-[9px] uppercase tracking-[0.14em] text-fg-subtle">
                robinhood chain
              </span>
            </div>

            <div className="space-y-5 px-5 py-6 sm:px-6">
              <div className="flex justify-end">
                <p className="max-w-[75%] rounded-2xl rounded-br-md bg-surface-raised px-3.5 py-2 text-sm text-fg">
                  buy 25 USDG of ANIME
                </p>
              </div>

              <StepCard
                step={{
                  kind: 'token_detail',
                  intentId: 'preview',
                  token: {
                    address: '0x0000000000000000000000000000000000000000',
                    symbol: 'ANIME',
                    name: 'ANIME FUN',
                    decimals: 18,
                    imageUrl: null,
                    websites: [],
                    socials: [{ url: 'https://x.com', label: 'twitter' }],
                  },
                  stats: {
                    priceUsd: 0.00042,
                    marketCap: 4_200_000,
                    fdv: 4_200_000,
                    volume24h: 318_000,
                    priceChange24h: 12.4,
                    buys24h: 1_204,
                    sells24h: 987,
                  },
                  pools: [
                    {
                      poolId: '0xpreview-usdg',
                      quoteSymbol: 'USDG',
                      quoteAddress: '0x0000000000000000000000000000000000000000',
                      liquidityUsd: 73_706,
                      priceUsd: 0.00042,
                      collapsed: 3,
                      source: 'dexscreener',
                    },
                    {
                      poolId: '0xpreview-eth',
                      quoteSymbol: 'ETH',
                      quoteAddress: '0x0000000000000000000000000000000000000000',
                      liquidityUsd: 50_589,
                      priceUsd: 0.00042,
                      collapsed: 18,
                      source: 'dexscreener',
                    },
                  ],
                  degraded: false,
                  message: 'ANIME trades on 2 venues. Which one?',
                }}
                onSelectToken={() => {}}
                onSelectPool={() => router.push('/dashboard')}
                onSubmitAmount={() => router.push('/dashboard')}
                onConfirm={() => {}}
                onRequote={() => {}}
                onPickToken={() => router.push('/dashboard')}
                onAsk={() => router.push('/dashboard')}
                onBuy={() => router.push('/dashboard')}
              />

              <Composer
                value={draft}
                onChange={setDraft}
                onSend={() => router.push('/dashboard')}
                placeholder='e.g. "buy 25 USDG of ANIME"'
              />
            </div>
          </div>
        </Reveal>

        <div className="mt-16 grid gap-12 md:grid-cols-3 md:gap-8">
          {features.map((f, i) => (
            <Reveal key={f.title} delay={i * 0.06}>
              <h3 className="font-display text-xl font-bold tracking-tight text-ink">
                {f.title}
              </h3>
              <p className="mt-3 text-sm leading-relaxed text-ink-muted">
                {f.body}
              </p>
            </Reveal>
          ))}
        </div>

        <Reveal className="mt-16">
          <Link
            href="/dashboard"
            className="inline-flex items-center gap-2.5 rounded-xl bg-ink px-6 py-3.5 text-base font-medium text-paper transition-all hover:bg-ink/85 active:scale-[0.98]"
          >
            Open Dashboard
          </Link>
        </Reveal>
      </div>
    </section>
  );
}