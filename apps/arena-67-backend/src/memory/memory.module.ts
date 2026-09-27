import { Global, Module } from '@nestjs/common';
import { MemoryController } from './memory.controller';
import { ConversationService } from './conversation.service';
import { EmbeddingService } from './embedding.service';

@Global()
@Module({
  controllers: [MemoryController],
  providers: [ConversationService, EmbeddingService],
  exports: [ConversationService, EmbeddingService],
})
export class MemoryModule {}
