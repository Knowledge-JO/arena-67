import { Global, Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { ChainService } from './chain.service';
import { PoolIndexService } from './pool-index.service';
import { TransferTaxService } from './transfer-tax.service';

@Global()
@Module({
  imports: [ScheduleModule.forRoot()],
  providers: [ChainService, PoolIndexService, TransferTaxService],
  exports: [ChainService, PoolIndexService, TransferTaxService],
})
export class ChainModule {}
