import { Module } from '@nestjs/common';
import { TokensController } from './tokens.controller';
import { TradingModule } from '../trading/trading.module';

@Module({
  imports: [TradingModule],
  controllers: [TokensController],
})
export class TokensLookupModule {}
