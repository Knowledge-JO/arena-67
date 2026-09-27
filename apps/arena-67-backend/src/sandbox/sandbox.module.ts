import { Global, Module } from '@nestjs/common';
import { SandboxService } from './sandbox.service';
import { SandboxController } from './sandbox.controller';

/** Global: trading, accounts, auth and the agent all need to know the mode. */
@Global()
@Module({
  controllers: [SandboxController],
  providers: [SandboxService],
  exports: [SandboxService],
})
export class SandboxModule {}
