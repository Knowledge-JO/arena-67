import { Module } from '@nestjs/common';
import { PendingIntentStore } from './pending-intent.store';
import { QuoteService } from './quote.service';
import { SwapService } from './swap.service';
import { TokensService } from './tokens.service';
import { TradingService } from './trading.service';
import { TradingController } from './trading.controller';

@Module({
  controllers: [TradingController],
  providers: [PendingIntentStore, QuoteService, SwapService, TokensService, TradingService],
  exports: [TradingService, TokensService, PendingIntentStore],
})
export class TradingModule {}
