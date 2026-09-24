'use client';

import Link from 'next/link';
import { motion, useReducedMotion, type Variants } from 'motion/react';

const container: Variants = {
  hidden: {},
  show: {
    transition: { staggerChildren: 0.1, delayChildren: 0.05 },
  },
};

const item = {
  hidden: { opacity: 0, y: 22 },
  show: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.7, ease: [0.16, 1, 0.3, 1] as const },
  },
} satisfies Variants;

export function Hero() {
  const reduce = useReducedMotion();

  return (
    <section className="relative flex min-h-dvh items-center">
      <div className="mx-auto w-full max-w-6xl px-5 pb-24 pt-24 sm:px-8">
        <motion.div
          variants={container}
          initial={reduce ? false : 'hidden'}
          animate={reduce ? undefined : 'show'}
        >
          <motion.p
            variants={item}
            className="font-ticker text-xs uppercase tracking-[0.22em] text-ink-subtle"
          >
            Robinhood Chain · Uniswap v4
          </motion.p>

          <motion.h1
            variants={item}
            className="mt-6 max-w-4xl font-display text-5xl font-bold leading-[0.98] tracking-tighter text-ink sm:text-6xl lg:text-7xl"
          >
            The memecoin <em className="font-semibold italic">arena</em> on
            Robinhood Chain.
          </motion.h1>

          <motion.p
            variants={item}
            className="mt-8 max-w-[42ch] text-lg leading-relaxed text-ink-muted"
          >
            Research and trade memecoins through a single chat. Live quotes,
            explicit confirmation, nothing signed without you.
          </motion.p>

          <motion.div variants={item} className="mt-10">
            <Link
              href="/dashboard"
              className="inline-flex items-center gap-2.5 rounded-xl bg-ink px-6 py-3.5 text-base font-medium text-paper transition-all hover:bg-ink/85 active:scale-[0.98]"
            >
              Open Dashboard
            </Link>
          </motion.div>
        </motion.div>
      </div>
    </section>
  );
}