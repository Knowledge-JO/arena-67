import { Injectable } from '@nestjs/common';
import { formatUnits, getAddress, isAddress } from 'viem';
import { ChainService } from '../chain/chain.service';
import { MarketService } from '../market/market.service';
import { HoldersService } from '../holders/holders.service';
import { signalsFor, type TokenReport } from './report.signals';

export type { Signal, TokenReport } from './report.signals';

export type ReportResult =
  | TokenReport
  | { isToken: false; address: string; reason: string };

/**
 * "What do you know about X", answered as one document.
 *
 * Market data, chain data and holder data are fetched together and each may
 * be missing on its own. A token Dexscreener has never seen still gets its
 * supply and holders, and a token whose holders are still indexing still gets
 * its market. Nothing here waits for the indexer.
 */
@Injectable()
export class ReportService {
  constructor(
    private readonly chain: ChainService,
    private readonly market: MarketService,
    private readonly holders: HoldersService,
  ) {}

  async report(address: string): Promise<ReportResult> {
    if (!isAddress(address)) {
      return { isToken: false, address, reason: 'That is not a valid contract address.' };
    }
    const token = getAddress(address);

    const [info, overview, view, holders] = await Promise.all([
      this.holders.supply(token),
      this.market.overview(token),
      this.market.forToken(token),
      this.holders.holders(token, { limit: 10 }),
    ]);

    if (!info && !overview) {
      return {
        isToken: false,
        address: token,
        reason: 'This address does not respond like a token on Robinhood Chain.',
      };
    }

    const decimals = info?.decimals ?? 18;
    const report: TokenReport = {
      kind: 'token_report',
      token: {
        address: token,
        symbol: view?.symbol || info?.symbol || '',
        name: view?.name || info?.name || '',
        decimals,
        totalSupply: info ? formatUnits(info.totalSupply, decimals) : '',
        imageUrl: view?.imageUrl ?? null,
        websites: view?.websites ?? [],
        socials: view?.socials ?? [],
        owner: info?.owner ?? null,
      },
      market: overview,
      pools: view?.pools ?? [],
      holders,
      signals: [],
      explorer: this.chain.network.explorer,
      asOf: new Date().toISOString(),
    };
    report.signals = signalsFor(report);
    return report;
  }
}
