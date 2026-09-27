import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import {
  NEW_MAX_AGE_HOURS,
  NEW_MIN_LIQUIDITY_USD,
  ResearchService,
  SIDEBAR_MAX,
  type SidebarView,
} from './research.service';

const VIEWS: SidebarView[] = ['h1', 'h6', 'h24', 'new'];

@Controller('research')
export class ResearchController {
  constructor(private readonly research: ResearchService) {}

  /** Pool-count ranking, for the landing page and the MCP trending tool. */
  @Get('trending')
  trending() {
    return this.research.snapshot();
  }

  /**
   * Just-launched tokens with liquidity, as a chat card — the agent's
   * list_new_tokens tool. Same list as the sidebar's New tab.
   */
  @Get('new-tokens')
  async newTokens(@Query('limit') limit = '10') {
    const n = Math.min(Math.max(Number.parseInt(limit, 10) || 10, 1), SIDEBAR_MAX);
    const list = await this.research.newTokens(n);
    return {
      kind: 'new_tokens' as const,
      tokens: list.tokens,
      total: list.total,
      maxAgeHours: NEW_MAX_AGE_HOURS,
      minLiquidityUsd: NEW_MIN_LIQUIDITY_USD,
      asOf: list.asOf,
    };
  }

  /**
   * The dashboard sidebar: most traded over 1h / 6h / 24h, or new tokens with
   * liquidity. `limit` grows as the user loads more.
   */
  @Get('sidebar')
  sidebar(@Query('view') view = 'h24', @Query('limit') limit = '12') {
    if (!VIEWS.includes(view as SidebarView)) {
      throw new BadRequestException(`view must be one of ${VIEWS.join(', ')}`);
    }
    const n = Math.min(Math.max(Number.parseInt(limit, 10) || 12, 1), SIDEBAR_MAX);
    return view === 'new'
      ? this.research.newTokens(n)
      : this.research.topByVolume(view as Exclude<SidebarView, 'new'>, n);
  }
}
