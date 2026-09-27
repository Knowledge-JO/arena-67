import { Module } from '@nestjs/common';
import { AccountsController } from './accounts.controller';
import { PortfolioService } from './portfolio.service';
import { HoldingsScannerService } from './holdings-scanner.service';

@Module({
  controllers: [AccountsController],
  providers: [PortfolioService, HoldingsScannerService],
  exports: [PortfolioService, HoldingsScannerService],
})
export class AccountsModule {}
