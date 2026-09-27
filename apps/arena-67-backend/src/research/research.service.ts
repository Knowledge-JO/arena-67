import { Injectable, Logger, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PoolIndexService } from '../chain/pool-index.service';
import { MarketService } from '../market/market.service';
import type { TokenVolume } from '../market/market.types';
import { RANKING_MAX, VolumeService, type VolumeWindow } from './volume.service';

export interface TrendingToken {
  address: string;
  symbol: string;
  name: string;
  /** Null rather than zero when market data is unavailable. */
  priceUsd: number | null;
  priceChange24h: number | null;
  volume24h: number | null;
  marketCap: number | null;
  /** When its first trading pool opened (epoch ms) — its launch, in practice. */
  launchedAt: number | null;
  imageUrl: string | null;
}

/** How many tokens the landing page and the trending tool get. */
const TRENDING = 12;

/** One row of the dashboard sidebar, whichever list it is in. */
export interface SidebarToken {
  address: string;
  symbol: string;
  name: string;
  imageUrl: string | null;
  priceUsd: number | null;
  marketCap: number | null;
  liquidityUsd: number | null;
  /** Over the list's window — 24h for new tokens. */
  volumeUsd: number | null;
  priceChangePct: number | null;
  /** When its first trading pool opened (epoch ms). */
  launchedAt: number | null;
}

export type SidebarView = VolumeWindow | 'new';

export interface SidebarList {
  view: SidebarView;
  tokens: SidebarToken[];
  /** How many the list holds in all — "load more" stops here. */
  total: number;
  /**
   * Volume lists only: minutes of swaps seen since the backend started. Below
   * the window, only tokens that traded in those minutes can be ranked.
   */
  observedMinutes: number | null;
  asOf: string;
}

/** Tokens with a recent pool, checked against the market for age and liquidity. Five requests. */
const NEW_CANDIDATES = 150;
/** Older than this, a token with a fresh pool is not new. */
export const NEW_MAX_AGE_HOURS = 48;
const NEW_MAX_AGE_MS = NEW_MAX_AGE_HOURS * 3_600_000;
/** "Liquidity already added": at least this much in its pools. */
export const NEW_MIN_LIQUIDITY_USD = 1_000;
const NEW_TTL_MS = 60_000;
export const SIDEBAR_MAX = RANKING_MAX;

/**
 * The research half of the arena: what is moving on Robinhood Chain.
 *
 * "Trending" is the most traded tokens over the last 24 hours by dollar
 * volume — the volume ranking, shared by the landing page, the agent's
 * trending tool and the sidebar's 24h tab. It used to be pool count, which
 * rewarded a deployer opening five empty pools as much as one deep market.
 *
 * Every market field is nullable. A token minted minutes ago may have no
 * price anywhere, and rendering that as `$0` would be a lie the UI cannot
 * detect.
 */
@Injectable()
export class ResearchService implements OnModuleInit {
  private readonly log = new Logger(ResearchService.name);
  private trending: TrendingToken[] = [];
  private lastRefresh = 0;
  private observedMinutes = 0;
  private lastError: string | null = null;

  private newList: { at: number; value: SidebarList } | null = null;
  private newInflight: Promise<SidebarList> | null = null;

  constructor(
    private readonly index: PoolIndexService,
    private readonly market: MarketService,
    private readonly volume: VolumeService,
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
      await this.newTokens(1).catch(() => undefined);
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
      const r = await this.volume.ranking('h24', TRENDING);
      this.trending = r.tokens.map((t) => ({
        address: t.address,
        symbol: t.symbol,
        name: t.name,
        priceUsd: t.priceUsd,
        priceChange24h: t.priceChange24h,
        volume24h: t.volumeUsd.h24,
        marketCap: t.marketCap,
        launchedAt: t.firstPoolAt,
        imageUrl: t.imageUrl,
      }));
      this.observedMinutes = r.observedMinutes;
      this.lastRefresh = Date.now();
      this.lastError = null;
      this.log.debug(`trending refreshed: ${this.trending.length} tokens`);
    } catch (err) {
      this.lastError = (err as Error).message;
      this.log.warn(`trending refresh failed, serving stale: ${this.lastError}`);
    }
  }

  /** Top tokens by 24h volume, for the landing page and the trending tool. */
  snapshot() {
    return {
      index: this.index.stats(),
      window: 'h24' as const,
      tokens: this.trending,
      /** Minutes of swaps seen so far; under 1440, only tokens traded in them are ranked. */
      observedMinutes: this.observedMinutes,
      lastRefresh: this.lastRefresh,
      stale: Date.now() - this.lastRefresh > 5 * 60_000,
      error: this.lastError,
    };
  }

  /** The sidebar's volume lists: most traded over the window, by dollar volume. */
  async topByVolume(window: VolumeWindow, limit: number): Promise<SidebarList> {
    const r = await this.volume.ranking(window, limit);
    return {
      view: window,
      tokens: r.tokens.map((t) => row(t, window)),
      total: r.total,
      observedMinutes: r.observedMinutes,
      asOf: r.asOf,
    };
  }

  /**
   * Tokens that just launched and can actually be traded: first pool opened
   * in the last two days, with real liquidity in it. Newest first.
   *
   * Candidates come from the pool index — every pool opened since a few hours
   * before the backend started. A new pool for an old token is dropped on
   * age, and a token Dexscreener has not listed yet is dropped too: without
   * it there is no liquidity figure to check, and a token with no liquidity
   * is exactly what this list must not show.
   */
  async newTokens(limit: number): Promise<SidebarList> {
    const hit = this.newList;
    let value: SidebarList;
    if (hit && Date.now() - hit.at < NEW_TTL_MS) value = hit.value;
    else if (hit) {
      void this.recomputeNew().catch((err: Error) =>
        this.log.warn(`new tokens refresh failed, serving previous: ${err.message.split('\n')[0]}`),
      );
      value = hit.value;
    } else value = await this.recomputeNew();
    return { ...value, tokens: value.tokens.slice(0, Math.min(Math.max(limit, 1), SIDEBAR_MAX)) };
  }

  private recomputeNew(): Promise<SidebarList> {
    if (!this.newInflight) {
      this.newInflight = this.computeNew().finally(() => (this.newInflight = null));
    }
    return this.newInflight;
  }

  private async computeNew(): Promise<SidebarList> {
    // The backfill reads oldest blocks first. Before it finishes, the "most
    // recent" pools are hours old and the newest launches are missing.
    if (!(await this.index.whenReady(60_000))) {
      throw new ServiceUnavailableException('Still reading recent launches from the chain. Try again in a moment.');
    }
    const candidates = this.index.recentTokens(NEW_CANDIDATES);
    const now = Date.now();
    const found = (await this.market.volumes(candidates))
      .filter(
        (v) =>
          v.firstPoolAt != null &&
          now - v.firstPoolAt <= NEW_MAX_AGE_MS &&
          (v.liquidityUsd ?? 0) >= NEW_MIN_LIQUIDITY_USD,
      )
      .sort((a, b) => (b.firstPoolAt ?? 0) - (a.firstPoolAt ?? 0))
      .slice(0, SIDEBAR_MAX);
    const value: SidebarList = {
      view: 'new',
      tokens: found.map((t) => row(t, 'h24')),
      total: found.length,
      observedMinutes: null,
      asOf: new Date().toISOString(),
    };
    this.newList = { at: Date.now(), value };
    return value;
  }
}

function row(t: TokenVolume, window: VolumeWindow): SidebarToken {
  return {
    address: t.address,
    symbol: t.symbol,
    name: t.name,
    imageUrl: t.imageUrl,
    priceUsd: t.priceUsd,
    marketCap: t.marketCap,
    liquidityUsd: t.liquidityUsd,
    volumeUsd: t.volumeUsd[window],
    priceChangePct: t.priceChange[window],
    launchedAt: t.firstPoolAt,
  };
}
