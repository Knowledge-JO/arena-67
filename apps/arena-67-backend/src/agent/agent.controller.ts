import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { AgentService } from './agent.service';
import { McpClientService } from './mcp-client.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser, type AuthedUser } from '../auth/current-user.decorator';
import { ConversationService } from '../memory/conversation.service';

/**
 * No `history` field. The client used to send its own transcript every turn,
 * which let it put words in the model's mouth. The server now owns the
 * conversation and loads it from the database.
 */
const ChatBody = z.object({
  /** Omit to start a new conversation. */
  conversationId: z.string().uuid().optional(),
  message: z.string().trim().min(1).max(2000),
});

@Controller('agent')
@UseGuards(JwtAuthGuard)
export class AgentController {
  constructor(
    private readonly agent: AgentService,
    private readonly mcp: McpClientService,
    private readonly conversations: ConversationService,
  ) {}

  @Get('status')
  status() {
    return this.mcp.status();
  }

  @Post('chat')
  @HttpCode(200)
  async chat(@CurrentUser() user: AuthedUser, @Body() body: unknown) {
    const parsed = ChatBody.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues.map((i) => i.message).join('; '));
    }

    let { conversationId } = parsed.data;
    if (conversationId) {
      await this.conversations.assertOwned(user.id, conversationId);
    } else {
      conversationId = (await this.conversations.create(user.id)).id;
    }

    const turn = await this.agent.chat(user.id, conversationId, parsed.data.message);

    return {
      conversationId,
      reply: turn.reply,
      toolsUsed: turn.toolsUsed,
      truncated: turn.truncated,
      rounds: turn.rounds,
      step: turn.step,
    };
  }
}
