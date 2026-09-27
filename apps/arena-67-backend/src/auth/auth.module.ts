import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtAuthGuard } from './jwt-auth.guard';
import { UserWalletService } from '../accounts/user-wallet.service';
import { TradeLedgerService } from '../accounts/trade-ledger.service';

/** Global: nearly every route needs to know who is asking. */
@Global()
@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_SECRET'),
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtAuthGuard, UserWalletService, TradeLedgerService],
  exports: [AuthService, JwtAuthGuard, UserWalletService, TradeLedgerService],
})
export class AuthModule {}
