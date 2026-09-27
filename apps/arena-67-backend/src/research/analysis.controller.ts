import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { isAddress } from 'viem';
import { z } from 'zod';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ChainService } from '../chain/chain.service';
import { HoldersService, MAX_OVERLAP_TOKENS, MAX_TOP_N } from '../holders/holders.service';
import { ReportService } from './report.service';
import { LivePriceService } from '../market/live-price.service';
import { VolumeService } from './volume.service';

const LABELS = ['wallet', 'pool', 'burn', 'token', 'contract'] as const;
const Address = z.string().refine((a) => isAddress(a), 'Must be a 0x address');

const OverlapBody = z.object({
  tokens: z.array(Address).min(2, 'Give at least two tokens').max(MAX_OVERLAP_TOKENS),
  topN: z.number().int().min(5).max(MAX_TOP_N).optional(),
  minTokens: z.number().int().min(2).optional(),
  include: z.array(z.enum(LABELS)).optional(),
});

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) throw new BadRequestException(r.error.issues.map((i) => i.message).join('; '));
  return r.data;
}

function address(value: string): string {
  if (!isAddress(value)) throw new BadRequestException('Not a valid 0x address');
  return value;
}

/**
 * Token reports, holders, volume ranking and holder overlap.
 *
 * Signed-in only — the browser by cookie, the MCP server on a user's behalf.
 * Several of these queue indexing work, which costs RPC time; an anonymous
 * caller able to queue arbitrary tokens could keep the indexer busy for
 * everyone.
 */
@Controller('research')
@UseGuards(JwtAuthGuard)
export class AnalysisController {
  constructor(
    private readonly reports: ReportService,
    private readonly holders: HoldersService,
    private readonly volume: VolumeService,
    private readonly chain: ChainService,
    private readonly livePrice: LivePriceService,
  ) {}

  @Get('tokens/:address/report')
  report(@Param('address') a: string) {
    return this.reports.report(address(a));
  }

  /**
   * Live price and market figures for an open report card. Cheap by design —
   * cards poll it every few seconds — so it queues nothing and reads one
   * cached slot0 per token.
   */
  @Get('tokens/:address/live')
  live(@Param('address') a: string) {
    return this.livePrice.live(address(a));
  }

  @Get('tokens/:address/holders')
  async tokenHolders(
    @Param('address') a: string,
    @Query('limit') limit?: string,
    @Query('include') include?: string,
  ) {
    const labels = include
      ? parse(z.array(z.enum(LABELS)), include.split(',').map((s) => s.trim()).filter(Boolean))
      : undefined;
    return {
      address: address(a),
      explorer: this.chain.network.explorer,
      ...(await this.holders.holders(a, { limit: Number(limit) || 10, include: labels })),
    };
  }

  /** Progress only. Queues nothing, so cards can poll it freely. */
  @Get('holders/status')
  status(@Query('tokens') tokens?: string) {
    const list = (tokens ?? '').split(',').map((t) => t.trim()).filter(Boolean);
    if (list.length === 0) throw new BadRequestException('tokens is required');
    return this.holders.status(list);
  }

  @Get('top-volume')
  async topVolume(@Query('window') window?: string, @Query('limit') limit?: string) {
    const w = parse(z.enum(['h1', 'h6', 'h24']).default('h24'), window || undefined);
    const ranking = await this.volume.ranking(w, Number(limit) || 10);
    return { kind: 'top_tokens', ...ranking };
  }

  @Post('common-holders')
  @HttpCode(200)
  async commonHolders(@Body() body: unknown) {
    const b = parse(OverlapBody, body);
    const result = await this.holders.commonHolders(b.tokens, b);
    return {
      kind: 'holder_overlap',
      ...result,
      explorer: this.chain.network.explorer,
      asOf: new Date().toISOString(),
    };
  }

  @Get('wallets/:address/holdings')
  async walletHoldings(@Param('address') a: string) {
    return {
      kind: 'wallet_holdings',
      ...(await this.holders.walletHoldings(address(a))),
      explorer: this.chain.network.explorer,
      asOf: new Date().toISOString(),
    };
  }
}
