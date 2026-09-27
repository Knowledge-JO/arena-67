import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Address } from 'viem';
import { ChainService } from '../chain/chain.service';
import { PoolIndexService, type PoolRecord } from '../chain/pool-index.service';
import { V4_QUOTER_ABI } from './uniswap-v4.abi';
import type { Quote } from './pending-intent.store';

export interface QuoteRequest {
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  maxSlippageBps: number;
  /**
   * Quote this pool and nothing else.
   *
   * Once a user has picked a venue off the token page, racing every candidate
   * and keeping the best fill is wrong: it could route through a pool with
   * different depth and fees than the one they agreed to, and the confirm card
   * would be describing a trade we are not making.
   */
  pool?: PoolRecord;
}

/** Quoting every pool for a hot pair is wasteful; the freshest few suffice. */
const MAX_POOLS_PROBED = 8;

/**
 * Canonical fee/tickSpacing pairs, used only as a fallback.
 *
 * The index covers a rolling recent window, which is right for memecoins —
 * they are minted constantly — but wrong for the long-established base pairs.
 * The ETH/USDG pool predates the window, so the index has never seen it, and
 * pricing the spend cap against it failed. Probing these tiers recovers such
 * pools without widening the backfill to millions of blocks.
 */
const FALLBACK_TIERS: ReadonlyArray<{ fee: number; tickSpacing: number }> = [
  { fee: 100, tickSpacing: 1 },
  { fee: 500, tickSpacing: 10 },
  { fee: 3000, tickSpacing: 60 },
  { fee: 10000, tickSpacing: 200 },
];

const NO_HOOK = '0x0000000000000000000000000000000000000000' as const;

/**
 * Prices a swap before anything is signed.
 *
 * The original plan went straight from "intent validated" to "sign and
 * broadcast". On memecoin liquidity that is how you eat a huge price impact or
 * buy into a honeypot, so a quote and an explicit human confirm sit between
 * the two.
 *
 * Candidate pools come from the index rather than from guessing fee tiers.
 * Measurement on this chain showed tier-guessing finds about 12% of pools:
 * dynamic-fee and hooked pools are invisible to it, and fee/tickSpacing do not
 * pair canonically here. Quoting the pools that demonstrably exist avoids all
 * of that, and carries each pool's real hook address into the swap.
 */
@Injectable()
export class QuoteService {
  private readonly log = new Logger(QuoteService.name);

  constructor(
    private readonly chain: ChainService,
    private readonly index: PoolIndexService,
  ) {}

  async quoteExactIn(req: QuoteRequest): Promise<Quote> {
    if (req.pool) {
      const only = await this.bestOf([req.pool], req);
      if (!only) {
        throw new Error(
          'That pool cannot fill this size right now. Try a smaller amount or another pool.',
        );
      }
      return this.build(only, req);
    }

    // Indexed pools first: they are real, recent, and carry their own hooks.
    const indexed = this.index.poolsFor(req.tokenIn, req.tokenOut);
    let best = await this.bestOf(indexed.slice(0, MAX_POOLS_PROBED), req);

    // Then the canonical tiers. This has to run even when the index returned
    // pools, not only when it returned none: for ETH/USDG the index is full of
    // thin launchpad pools that all revert, while the deep pool that can
    // actually fill the order predates the backfill window and is invisible
    // to it. Gating the fallback on an empty index meant never reaching it.
    if (!best) best = await this.bestOf(this.fallbackPools(req), req);

    if (!best) {
      throw new Error(
        indexed.length
          ? `Found ${indexed.length} pool(s) for that pair but none could fill this size.`
          : 'No Uniswap v4 pool is indexed for that pair on Robinhood Chain.',
      );
    }

    return this.build(best, req);
  }

  private build(
    best: { pool: PoolRecord; amountOut: bigint },
    req: QuoteRequest,
  ): Quote {
    const bps = BigInt(Math.round(req.maxSlippageBps));
    return {
      id: randomUUID(),
      amountIn: req.amountIn,
      amountOut: best.amountOut,
      minAmountOut: (best.amountOut * (10_000n - bps)) / 10_000n,
      priceImpactBps: 0, // would need spot from StateView; shown as unknown
      feeTier: best.pool.fee,
      tickSpacing: best.pool.tickSpacing,
      hooks: best.pool.hooks,
      poolId: best.pool.id,
      quotedAt: Date.now(),
    };
  }

  /** Quotes a set of pools in parallel and keeps the best actual fill. */
  private async bestOf(
    pools: PoolRecord[],
    req: QuoteRequest,
  ): Promise<{ pool: PoolRecord; amountOut: bigint } | null> {
    if (pools.length === 0) return null;
    const probed = await Promise.allSettled(
      pools.map((pool) => this.probe(pool, req)),
    );
    return (
      probed
        .filter(
          (p): p is PromiseFulfilledResult<{ pool: PoolRecord; amountOut: bigint }> =>
            p.status === 'fulfilled' && p.value.amountOut > 0n,
        )
        .map((p) => p.value)
        .sort((a, b) => (b.amountOut > a.amountOut ? 1 : -1))[0] ?? null
    );
  }

  /** Synthesises canonical hookless PoolKeys; bad guesses just revert. */
  private fallbackPools(req: QuoteRequest): PoolRecord[] {
    const [currency0, currency1] =
      req.tokenIn.toLowerCase() < req.tokenOut.toLowerCase()
        ? [req.tokenIn, req.tokenOut]
        : [req.tokenOut, req.tokenIn];
    return FALLBACK_TIERS.map(({ fee, tickSpacing }) => ({
      id: `fallback-${fee}-${tickSpacing}`,
      currency0,
      currency1,
      fee,
      tickSpacing,
      hooks: NO_HOOK,
      block: 0n,
    }));
  }

  private async probe(
    pool: PoolRecord,
    req: QuoteRequest,
  ): Promise<{ pool: PoolRecord; amountOut: bigint }> {
    const zeroForOne =
      req.tokenIn.toLowerCase() === pool.currency0.toLowerCase();

    const { result } = await this.chain.client.simulateContract({
      address: this.chain.network.uniswapV4.QUOTER,
      abi: V4_QUOTER_ABI,
      functionName: 'quoteExactInputSingle',
      args: [
        {
          poolKey: {
            currency0: pool.currency0,
            currency1: pool.currency1,
            fee: pool.fee,
            tickSpacing: pool.tickSpacing,
            hooks: pool.hooks,
          },
          zeroForOne,
          exactAmount: req.amountIn,
          hookData: '0x',
        },
      ],
    });
    return { pool, amountOut: result[0] as bigint };
  }
}
