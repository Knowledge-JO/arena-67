import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PoolIndexService } from '../chain/pool-index.service';
import { MarketService } from '../market/market.service';

export interface TrendingToken {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  poolCount: number;
  /** Null rather than zero when market data is unavailable. */
  priceUsd: number | null;
  priceChange24h: number | null;
  volume24h: number | null;
  imageUrl: string | null;
}

/** How many tokens get a market lookup. Each is one upstream request. */
const ENRICH = 12;

/**
 * The research half of the arena: what is moving on Robinhood Chain.
 *
 * Ranking is by pool count within the index window, which is a proxy for
 * activity rather than volume — honest, because it comes straight from chain
 * state, but it rewards many thin pools as much as one deep one. Price and
 * volume are layered on from the market service so the pane shows numbers
 * traders actually recognise.
 *
 * Every enriched field is nullable. A token minted minutes ago has no price
 * anywhere, and rendering that as `$0` would be a lie the UI cannot detect.
 */
@Injectable()
export class ResearchService implements OnModuleInit {
  private readonly log = new Logger(ResearchService.name);
  private trending: TrendingToken[] = [];
  private lastRefresh = 0;
  private lastError: string | null = null;

  constructor(
    private readonly index: PoolIndexService,
    private readonly market: MarketService,
  ) {}

  /**
   * Fills the panel at startup instead of leaving it blank until the first
   * cron tick — a blank sidebar reads as a broken backend.
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

  @Cron(CronExpression.EVERY_MINUTE)
  async refresh(): Promise<void> {
    try {
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
      stale: Date.now() - this.lastRefresh > 5 * 60_000,
      error: this.lastError,
    };
  }

  private async fetchTopTraded(): Promise<TrendingToken[]> {
    const hot = await this.index.hottest(ENRICH);

    // Enrichment runs in parallel and is allowed to fail per-token: one
    // unknown contract must not blank the whole pane.
    const enriched = await Promise.all(
      hot.map(async (t) => {
        const base: TrendingToken = {
          address: t.address,
          symbol: t.symbol,
          name: t.name,
          decimals: t.decimals,
          poolCount: t.poolCount,
          priceUsd: null,
          priceChange24h: null,
          volume24h: null,
          imageUrl: null,
        };
        try {
          const m = await this.market.forToken(t.address);
          if (!m) return base;
          return {
            ...base,
            symbol: m.symbol || base.symbol,
            name: m.name || base.name,
            priceUsd: m.stats?.priceUsd ?? null,
            priceChange24h: m.stats?.priceChange24h ?? null,
            volume24h: m.stats?.volume24h ?? null,
            imageUrl: m.imageUrl,
          };
        } catch {
          return base;
        }
      }),
    );

    return enriched;
  }
}
