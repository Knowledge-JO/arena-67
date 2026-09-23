import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PoolIndexService } from '../chain/pool-index.service';

export interface TrendingToken {
  address: string;
  symbol: string;
  name: string;
  volume24hUsd: number;
  priceChange24hPct: number;
  liquidityUsd: number;
  poolCount: number;
}

/**
 * The research half of the arena: what is actually moving on Robinhood Chain.
 *
 * Scoped deliberately to on-chain top-traded rather than the X firehose and
 * news ingestion the original plan called for. Those need a paid X tier and
 * two more pipelines; this needs one poll and is the closer match to "top
 * trading memecoins right now".
 *
 * Results are cached and served from memory so the UI never waits on an
 * upstream call, and a failed refresh keeps serving the last good snapshot
 * rather than blanking the panel.
 */
@Injectable()
export class ResearchService implements OnModuleInit {
  private readonly log = new Logger(ResearchService.name);
  private trending: TrendingToken[] = [];
  private lastRefresh = 0;
  private lastError: string | null = null;

  constructor(private readonly index: PoolIndexService) {}

  /**
   * Fills the panel at startup instead of leaving it blank until the first
   * cron tick — five minutes of an empty sidebar reads as a broken backend.
   *
   * The pool index backfills in the background, so this waits for it to report
   * ready rather than racing it and caching an empty list.
   */
  onModuleInit(): void {
    void this.primeWhenIndexed();
  }

  private async primeWhenIndexed(attempt = 0): Promise<void> {
    if (this.index.stats().ready) {
      await this.refresh();
      return;
    }
    if (attempt > 40) {
      this.log.warn('pool index never reported ready; trending left to cron');
      return;
    }
    setTimeout(() => void this.primeWhenIndexed(attempt + 1), 3_000);
  }

  @Cron(CronExpression.EVERY_5_MINUTES)
  async refresh(): Promise<void> {
    try {
      // TODO: source from hood-mcp's memecoin/chain-stats tools.
      const next = await this.fetchTopTraded();
      this.trending = next;
      this.lastRefresh = Date.now();
      this.lastError = null;
      this.log.debug(`trending refreshed: ${next.length} tokens`);
    } catch (err) {
      this.lastError = (err as Error).message;
      this.log.warn(`trending refresh failed, serving stale: ${this.lastError}`);
    }
  }

  snapshot() {
    return {
      index: this.index.stats(),
      tokens: this.trending,
      lastRefresh: this.lastRefresh,
      stale: Date.now() - this.lastRefresh > 15 * 60_000,
      error: this.lastError,
    };
  }

  /**
   * Ranks by how many pools reference a token. That is a proxy for activity,
   * not volume — an honest one, since it comes straight from chain state — but
   * it rewards tokens with many thin pools as much as one deep pool. Swapping
   * in real 24h volume is the obvious upgrade once an indexer is available.
   */
  private async fetchTopTraded(): Promise<TrendingToken[]> {
    const hot = await this.index.hottest(12);
    return hot.map((t) => ({
      address: t.address,
      symbol: t.symbol,
      name: t.name,
      volume24hUsd: 0,
      priceChange24hPct: 0,
      liquidityUsd: 0,
      poolCount: t.poolCount,
    }));
  }
}
