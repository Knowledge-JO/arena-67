import { McpServer } from '@modelcontextprotocol/server';
import { type AxiosInstance } from 'axios';
import { createApiClient } from '../api/api.js';
import { registerResearchResources } from './research/resources.js';
import { registerResearchTools } from './research/tools.js';
import { registerAnalysisTools } from './research/analysis.js';
import { registerTradingTools } from './trading/tools.js';
import { registerAccountTools } from './account/tools.js';

/**
 * Arena 67's tools: research a memecoin on Robinhood Chain, and prepare a
 * trade up to the point a human has to agree to it.
 *
 * The split between the two halves is deliberate. Research is free and
 * reversible, so the model may do as much of it as it likes. Trading stops at
 * the quote — see the note in trading/tools.ts on why signing is not a tool.
 */
function createArenaServer(api: AxiosInstance = createApiClient()): McpServer {
  const server = new McpServer({
    name: 'arena-67-mcp',
    version: '1.0.0',
  });

  registerResearchTools(server, api);
  registerAnalysisTools(server, api);
  registerResearchResources(server, api);
  registerTradingTools(server, api);
  registerAccountTools(server, api);

  return server;
}

export { createArenaServer };
