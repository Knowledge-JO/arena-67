import { Module } from '@nestjs/common';
import { AgentController } from './agent.controller';
import { AgentService } from './agent.service';
import { McpClientService } from './mcp-client.service';
import { ReasoningService } from './reasoning.service';

@Module({
  controllers: [AgentController],
  providers: [AgentService, McpClientService, ReasoningService],
  exports: [AgentService],
})
export class AgentModule {}
