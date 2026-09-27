import { Global, Module } from '@nestjs/common';
import { HolderIndexService } from './holder-index.service';
import { AddressLabelService } from './address-label.service';
import { HoldersService } from './holders.service';

/** Global: research reads holders, and the volume ranking feeds the index. */
@Global()
@Module({
  providers: [HolderIndexService, AddressLabelService, HoldersService],
  exports: [HolderIndexService, AddressLabelService, HoldersService],
})
export class HoldersModule {}
