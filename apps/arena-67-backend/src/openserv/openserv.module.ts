import { Module } from '@nestjs/common';
import { TradingModule } from '../trading/trading.module';
import { ArenaAgentService } from './arena-agent.service';

@Module({
  imports: [TradingModule],
  providers: [ArenaAgentService],
})
export class OpenServModule {}
