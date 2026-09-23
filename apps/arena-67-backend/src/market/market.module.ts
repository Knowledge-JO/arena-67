import { Global, Module } from '@nestjs/common';
import { MarketService } from './market.service';

/** Global: both the trading flow and the research pane want market data. */
@Global()
@Module({ providers: [MarketService], exports: [MarketService] })
export class MarketModule {}
