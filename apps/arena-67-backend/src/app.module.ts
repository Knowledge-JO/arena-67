import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from './config/env.validation';
import { ServiceAuthGuard } from './auth/service-auth.guard';
import { ChainModule } from './chain/chain.module';
import { DatabaseModule } from './database/database.module';
import { CryptoModule } from './crypto/crypto.module';
import { MailModule } from './mail/mail.module';
import { AuthModule } from './auth/auth.module';
import { AccountsModule } from './accounts/accounts.module';
import { MemoryModule } from './memory/memory.module';
import { TradingModule } from './trading/trading.module';
import { MarketModule } from './market/market.module';
import { TokensLookupModule } from './tokens/tokens.module';
import { AgentModule } from './agent/agent.module';
import { OpenServModule } from './openserv/openserv.module';
import { ResearchModule } from './research/research.module';
import { HoldersModule } from './holders/holders.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    DatabaseModule,
    CryptoModule,
    MailModule,
    ChainModule,
    AuthModule,
    AccountsModule,
    MemoryModule,
    MarketModule,
    TradingModule,
    TokensLookupModule,
    HoldersModule,
    ResearchModule,
    AgentModule,
    // Tunnel opens only when explicitly enabled, so the desk can run solo.
    ...(process.env.ENABLE_OPENSERV_AGENT === 'true' ? [OpenServModule] : []),
  ],
  // Global so every route is tagged with its caller, rather than each
  // controller having to remember to ask.
  providers: [{ provide: APP_GUARD, useClass: ServiceAuthGuard }],
})
export class AppModule {}
