import { Global, Module } from '@nestjs/common';
import { MarketService } from './market.service';
import { LivePriceService } from './live-price.service';

/** Global: both the trading flow and the research pane want market data. */
@Global()
@Module({
  providers: [MarketService, LivePriceService],
  exports: [MarketService, LivePriceService],
})
export class MarketModule {}
