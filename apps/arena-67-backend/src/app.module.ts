import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from './config/env.validation';
import { ChainModule } from './chain/chain.module';
import { WalletModule } from './wallet/wallet.module';
import { TradingModule } from './trading/trading.module';
import { OpenServModule } from './openserv/openserv.module';
import { ResearchModule } from './research/research.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    ChainModule,
    WalletModule,
    TradingModule,
    ResearchModule,
    // Tunnel opens only when explicitly enabled, so the desk can run solo.
    ...(process.env.ENABLE_OPENSERV_AGENT === 'true' ? [OpenServModule] : []),
  ],
})
export class AppModule {}
