import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { ResearchService, SIDEBAR_MAX, type SidebarView } from './research.service';

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
