import { Global, Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { ChainService } from './chain.service';
import { PoolIndexService } from './pool-index.service';

@Global()
@Module({
  imports: [ScheduleModule.forRoot()],
  providers: [ChainService, PoolIndexService],
  exports: [ChainService, PoolIndexService],
})
export class ChainModule {}
