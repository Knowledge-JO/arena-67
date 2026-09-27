import { Global, Module } from '@nestjs/common';
import { WalletKeyService } from './wallet-key.service';

/** Global: a master key is infrastructure, not a feature dependency. */
@Global()
@Module({ providers: [WalletKeyService], exports: [WalletKeyService] })
export class CryptoModule {}
