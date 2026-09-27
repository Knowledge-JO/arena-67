import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { parseAbiItem } from 'viem';
import { ChainService } from '../chain/chain.service';
import { NATIVE_TOKEN } from '../chain/networks';
import { MarketService } from '../market/market.service';
import type { TokenVolume } from '../market/market.types';
import { HolderIndexService, PRIORITY } from '../holders/holder-index.service';
import { walkLogs } from '../holders/transfer-fold';
import { DRIZZLE } from '../database/database.constants';
import { dbOf, type Database } from '../database/database.module';
import { walletTokens } from '../database/schema';

const SWAP_EVENT = parseAbiItem(
  'event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)',
);

export type VolumeWindow = 'h1' | 'h6' | 'h24';

/** ~0.1s blocks: one bucket is a minute of chain. */
const BLOCKS_PER_MINUTE = 600n;
const WINDOW_MINUTES: Record<VolumeWindow, number> = { h1: 60, h6: 360, h24: 1440 };
/** History read at boot. More is ~40s per extra half hour of RPC time. */
const BOOT_MINUTES = 30;
/** Most-swapped pools sent to Dexscreener. Ten requests at thirty per call. */
const POOLS_TO_PRICE = 300;
/** Distinct tokens priced for the final ranking. Three requests. */
const TOKENS_TO_RANK = 90;
const RANKING_TTL_MS = 3 * 60_000;
/** The top tokens by 24h volume are kept holder-indexed ahead of anyone asking. */
const TRACK_TOP = 20;

export interface VolumeRanking {
  window: VolumeWindow;
  tokens: Array<TokenVolume & { rank: number }>;
  /** Minutes of swap activity actually observed. Candidates come only from these. */
  observedMinutes: number;
  asOf: string;
}

/**
 * "Which tokens traded the most" on a chain with no volume index.
 *
 * Measured: the v4 PoolManager emits about a thousand Swap events a minute,
 * so reading a whole day of them is ~40 minutes of RPC calls — but keeping up
 * with them is one or two calls a minute. So this tails swaps, counts them per
 * pool in one-minute buckets, and treats the busiest pools as candidates.
 * Dexscreener turns pool ids into tokens and supplies the actual volume, which
 * is what the ranking sorts by. Swap counts only decide what gets looked up.
 *
 * A token that did not swap on v4 inside the observed window is not ranked.
 * The response says how many minutes were observed, so that is never hidden.
 */
@Injectable()
export class VolumeService implements OnModuleInit {
  private readonly log = new Logger(VolumeService.name);
  private readonly db: Database;
  /** bucket (block / 600) → poolId → swaps */
  private readonly buckets = new Map<bigint, Map<string, number>>();
  private cursor: bigint | null = null;
  private observedFrom: bigint | null = null;
  private tailing = false;
  private readonly rankings = new Map<VolumeWindow, { at: number; value: VolumeRanking }>();
  private readonly inflight = new Map<VolumeWindow, Promise<VolumeRanking>>();

  constructor(
    @Inject(DRIZZLE) handle: unknown,
    private readonly chain: ChainService,
    private readonly market: MarketService,
    private readonly holders: HolderIndexService,
  ) {
    this.db = dbOf(handle);
  }

  onModuleInit(): void {
    // Not awaited: half an hour of swaps takes the better part of a minute
    // to read, and nothing else should wait on it.
    void (async () => {
      try {
        const head = await this.chain.latestBlock();
        const from = head - BigInt(BOOT_MINUTES) * BLOCKS_PER_MINUTE;
        this.observedFrom = from;
        this.cursor = from - 1n;
        await this.advance(head);
        this.log.log(`swap activity warm — ${this.poolCount()} active pools`);
        await this.track();
      } catch (err) {
        this.log.warn(`swap backfill failed, tail will retry: ${(err as Error).message.split('\n')[0]}`);
      }
    })();
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async tail(): Promise<void> {
    if (this.cursor == null) return;
    try {
      await this.advance(await this.chain.latestBlock());
    } catch (err) {
      this.log.warn(`swap tail failed: ${(err as Error).message.split('\n')[0]}`);
    }
  }

  private async advance(head: bigint): Promise<void> {
    if (this.tailing || this.cursor == null || head <= this.cursor) return;
    this.tailing = true;
    try {
      await walkLogs({
        from: this.cursor + 1n,
        to: head,
        span: 5_000n,
        fetch: (a, b) =>
          this.chain.backgroundClient.getLogs({
            address: this.chain.network.uniswapV4.POOL_MANAGER,
            event: SWAP_EVENT,
            fromBlock: a,
            toBlock: b,
          }),
        onChunk: async (logs, _a, b) => {
          for (const l of logs) {
            if (l.blockNumber == null || !l.args.id) continue;
            const bucket = l.blockNumber / BLOCKS_PER_MINUTE;
            let m = this.buckets.get(bucket);
            if (!m) this.buckets.set(bucket, (m = new Map()));
            m.set(l.args.id, (m.get(l.args.id) ?? 0) + 1);
          }
          this.cursor = b;
        },
      });
      this.prune(head);
    } finally {
      this.tailing = false;
    }
  }

  private prune(head: bigint): void {
    const oldest = head / BLOCKS_PER_MINUTE - BigInt(WINDOW_MINUTES.h24);
    for (const k of this.buckets.keys()) if (k < oldest) this.buckets.delete(k);
    const floor = oldest * BLOCKS_PER_MINUTE;
    if (this.observedFrom != null && this.observedFrom < floor) this.observedFrom = floor;
  }

  private poolCount(): number {
    const ids = new Set<string>();
    for (const m of this.buckets.values()) for (const id of m.keys()) ids.add(id);
    return ids.size;
  }

  private observedMinutes(): number {
    if (this.cursor == null || this.observedFrom == null) return 0;
    return Math.max(0, Number((this.cursor - this.observedFrom) / BLOCKS_PER_MINUTE));
  }

  /** Most-swapped pools within the window, busiest first. */
  private activePools(window: VolumeWindow): string[] {
    if (this.cursor == null) return [];
    const since = this.cursor / BLOCKS_PER_MINUTE - BigInt(WINDOW_MINUTES[window]);
    const totals = new Map<string, number>();
    for (const [bucket, m] of this.buckets) {
      if (bucket < since) continue;
      for (const [id, n] of m) totals.set(id, (totals.get(id) ?? 0) + n);
    }
    return [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
  }

  /** Top tokens by USD volume over the window. Cached a few minutes. */
  async ranking(window: VolumeWindow = 'h24', limit = 10): Promise<VolumeRanking> {
    const hit = this.rankings.get(window);
    const fresh = hit && Date.now() - hit.at < RANKING_TTL_MS ? hit.value : null;
    const value =
      fresh ??
      (await (this.inflight.get(window) ??
        (() => {
          const work = this.compute(window).finally(() => this.inflight.delete(window));
          this.inflight.set(window, work);
          return work;
        })()));
    return { ...value, tokens: value.tokens.slice(0, Math.min(Math.max(limit, 1), 50)) };
  }

  private async compute(window: VolumeWindow): Promise<VolumeRanking> {
    const pools = this.activePools(window).slice(0, POOLS_TO_PRICE);
    const bases = new Set<string>([
      NATIVE_TOKEN.toLowerCase(),
      '0x0000000000000000000000000000000000000000',
      ...Object.values(this.chain.network.baseTokens).map((b) => b.address.toLowerCase()),
    ]);

    // Pool → the token it is really about. Dexscreener's base token, unless
    // that is ETH or a dollar, in which case the other side.
    const pairs = pools.length ? await this.market.pairsByIds(pools) : [];
    const order = new Map(pools.map((id, i) => [id.toLowerCase(), i]));
    const candidates: string[] = [];
    const seen = new Set<string>();
    for (const p of pairs.sort(
      (a, b) =>
        (order.get(a.pairAddress.toLowerCase()) ?? 1e9) - (order.get(b.pairAddress.toLowerCase()) ?? 1e9),
    )) {
      const base = p.baseToken.address.toLowerCase();
      const quote = p.quoteToken.address.toLowerCase();
      const token = bases.has(base) ? (bases.has(quote) ? null : quote) : base;
      if (!token || seen.has(token)) continue;
      seen.add(token);
      candidates.push(token);
    }

    const volumes = await this.market.volumes(candidates.slice(0, TOKENS_TO_RANK));
    const ranked = volumes
      .filter((v) => (v.volumeUsd[window] ?? 0) > 0)
      .sort((a, b) => (b.volumeUsd[window] ?? 0) - (a.volumeUsd[window] ?? 0))
      .map((v, i) => ({ ...v, rank: i + 1 }));

    const value: VolumeRanking = {
      window,
      tokens: ranked,
      observedMinutes: this.observedMinutes(),
      asOf: new Date().toISOString(),
    };
    this.rankings.set(window, { at: Date.now(), value });
    return value;
  }

  /**
   * Keeps holder data warm for what people are likely to ask about: the top
   * tokens by 24h volume, and whatever our own users hold.
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async track(): Promise<void> {
    try {
      const top = await this.ranking('h24', TRACK_TOP);
      for (const t of top.tokens) await this.holders.request(t.address, PRIORITY.topVolume);

      const held = await this.db
        .selectDistinct({ token: walletTokens.tokenAddress })
        .from(walletTokens);
      for (const h of held) await this.holders.request(h.token, PRIORITY.heldByUser);
    } catch (err) {
      this.log.warn(`holder tracking refresh failed: ${(err as Error).message.split('\n')[0]}`);
    }
  }
}
