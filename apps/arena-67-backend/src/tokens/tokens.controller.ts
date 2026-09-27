import { Controller, Get, Param, Query, BadRequestException } from '@nestjs/common';
import { isAddress } from 'viem';
import { PoolIndexService } from '../chain/pool-index.service';
import { MarketService } from '../market/market.service';
import { TokensService } from '../trading/tokens.service';

/**
 * Read-only token lookup, for anything that wants to answer a question rather
 * than place a trade.
 *
 * The chat previously had only one verb: a regex that recognised "buy X" and
 * rejected everything else, so "what is VLAD" and "is 0x883 a token?" both got
 * the same canned reply. Those are lookups, not trades, and they need their
 * own surface.
 */
@Controller('tokens')
export class TokensController {
  constructor(
    private readonly index: PoolIndexService,
    private readonly market: MarketService,
    private readonly tokens: TokensService,
  ) {}

  /**
   * Ticker or name search, enriched with market data.
   *
   * Candidates carry price and market cap because a list of eight identical
   * tickers is not a choice — the addresses are indistinguishable to a human.
   * Cap and volume are what actually separate the token people mean from the
   * seven copies trading on it.
   *
   * Enrichment is per-token and allowed to fail: a candidate with no market
   * still appears, with nulls, rather than being dropped from a list it
   * belongs in.
   */
  @Get('search')
  async search(@Query('q') q?: string, @Query('limit') limit?: string) {
    const query = q?.trim();
    if (!query) throw new BadRequestException('q is required');
    const max = Math.min(Number(limit) || 8, 25);

    // Two sources: the pool index (fresh launches, including ones too new
    // for Dexscreener) and Dexscreener's search (everything older than the
    // index window). Merged by address.
    const [indexed, listed] = await Promise.all([
      this.index.search(query, max),
      this.market.search(query).catch(() => []),
    ]);
    const hits = new Map<string, { address: string; symbol: string; name: string; decimals: number; poolCount: number }>();
    for (const t of indexed) hits.set(t.address.toLowerCase(), t);
    for (const t of listed) {
      if (hits.has(t.address.toLowerCase())) continue;
      const meta = this.index.metaOf(t.address);
      hits.set(t.address.toLowerCase(), {
        address: t.address,
        symbol: t.symbol,
        name: t.name,
        decimals: meta?.decimals ?? 18,
        poolCount: t.pairs,
      });
    }

    const results = await Promise.all(
      [...hits.values()].slice(0, max * 2).map(async (t) => {
        const base = {
          address: t.address,
          symbol: t.symbol,
          name: t.name,
          decimals: t.decimals,
          poolCount: t.poolCount,
          priceUsd: null as number | null,
          marketCap: null as number | null,
          volume24h: null as number | null,
          priceChange24h: null as number | null,
          imageUrl: null as string | null,
        };
        try {
          const m = await this.market.forToken(t.address);
          if (!m) return base;
          return {
            ...base,
            symbol: m.symbol || base.symbol,
            name: m.name || base.name,
            priceUsd: m.stats?.priceUsd ?? null,
            marketCap: m.stats?.marketCap ?? null,
            volume24h: m.stats?.volume24h ?? null,
            priceChange24h: m.stats?.priceChange24h ?? null,
            imageUrl: m.imageUrl,
          };
        } catch {
          return base;
        }
      }),
    );

    // Rank by market cap where known, then by pool activity. An unpriced token
    // sinks below priced ones rather than being sorted as if worth zero.
    results.sort((a, b) => {
      if (a.marketCap != null && b.marketCap != null) {
        return b.marketCap - a.marketCap;
      }
      if (a.marketCap != null) return -1;
      if (b.marketCap != null) return 1;
      return b.poolCount - a.poolCount;
    });

    return { query, results: results.slice(0, max) };
  }

  /**
   * Full market view for one token.
   *
   * Answers "is this address a token?" honestly in three ways: a malformed
   * address is a 400, a contract that does not respond to ERC-20 calls comes
   * back `isToken: false`, and a real token with no market yet comes back with
   * `market: null` rather than invented numbers.
   */
  @Get(':address')
  async detail(@Param('address') address: string) {
    if (!isAddress(address)) {
      throw new BadRequestException('Not a valid EVM address');
    }

    const described = await this.tokens.describe(address);
    if (!described) {
      return {
        address,
        isToken: false,
        reason: 'This address does not answer ERC-20 calls on Robinhood Chain.',
      };
    }

    const market = await this.market.forToken(address);
    return {
      address: described.address,
      isToken: true,
      symbol: market?.symbol || described.symbol,
      name: market?.name || described.name,
      decimals: described.decimals,
      market: market
        ? {
            imageUrl: market.imageUrl,
            websites: market.websites,
            socials: market.socials,
            stats: market.stats,
            pools: market.pools,
            degraded: market.degraded,
          }
        : null,
    };
  }
}
