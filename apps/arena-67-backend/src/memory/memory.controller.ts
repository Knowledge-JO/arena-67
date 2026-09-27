import {
  BadRequestException,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser, type AuthedUser } from '../auth/current-user.decorator';
import { ConversationService } from './conversation.service';

@Controller()
@UseGuards(JwtAuthGuard)
export class MemoryController {
  constructor(private readonly conversations: ConversationService) {}

  @Get('conversations')
  list(@CurrentUser() user: AuthedUser) {
    return this.conversations.list(user.id);
  }

  @Post('conversations')
  @HttpCode(201)
  create(@CurrentUser() user: AuthedUser) {
    return this.conversations.create(user.id);
  }

  @Get('conversations/:id/messages')
  messages(
    @CurrentUser() user: AuthedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.conversations.messagesOf(user.id, id);
  }

  /** Called by the MCP recall tool, acting for the user its token names. */
  @Get('memory/recall')
  async recall(
    @CurrentUser() user: AuthedUser,
    @Query('q') q?: string,
    @Query('conversationId') conversationId?: string,
  ) {
    if (!q?.trim() || !conversationId) {
      throw new BadRequestException('q and conversationId are required');
    }
    const memories = await this.conversations.recall(user.id, q, conversationId);
    return {
      memories,
      note:
        memories.length === 0
          ? 'Nothing relevant found in earlier conversations.'
          : 'Approximate recollections from earlier conversations — not a record of fact.',
    };
  }
}
