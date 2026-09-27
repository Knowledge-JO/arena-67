import { McpServer } from '@modelcontextprotocol/server';
import { type AxiosInstance } from 'axios';
import { z } from 'zod';
import {
  getPortfolio,
  getTradeHistory,
  recallMemory,
} from '../../api/arena/api.arena.js';
import { toolError, toolSuccess } from '../shared/responses.js';

/**
 * The signed-in user's own account: holdings, trades, and memory.
 *
 * None of these tools takes a user id, and that absence is the security
 * boundary. Whose account they read is decided by the per-request token the
 * backend attached to this server instance — something the model cannot see
 * or alter. A tool that accepted `userId` would let a prompt injection hidden
 * in a token's name ask for somebody else's portfolio.
 */
export function registerAccountTools(server: McpServer, api: AxiosInstance) {
  server.registerTool(
    'get_portfolio',
    {
      title: "Get the user's portfolio",
      description:
        "The signed-in user's wallet: every token it holds with balance, price " +
        'and USD value, plus the total. Use when they ask what they hold, their ' +
        'balance, or their portfolio. Tokens with no market are listed but ' +
        'excluded from the total — say how many, never value them at zero.',
      inputSchema: {},
    },
    async () => {
      try {
        return toolSuccess(await getPortfolio(api));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'get_trade_history',
    {
      title: "Get the user's trade history",
      description:
        'Trades the user has made through Arena, newest first. The authority for ' +
        '"what did I buy/sell" — prefer this over recalled conversation, which ' +
        'is approximate where this is exact.',
      inputSchema: {},
    },
    async () => {
      try {
        return toolSuccess({ trades: await getTradeHistory(api) });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'recall_memory',
    {
      title: 'Recall earlier conversations',
      description:
        "Searches the user's previous conversations by meaning. Use for things " +
        'like "that token we discussed last week" or "what did I say about X". ' +
        'Results are approximate — quote them as recollection, not fact. For ' +
        'trades or holdings use get_trade_history or get_portfolio instead.',
      inputSchema: {
        query: z.string().min(2).describe('What to look for, in plain words.'),
        conversationId: z
          .string()
          .uuid()
          .describe('The current conversation, excluded from results.'),
      },
    },
    async ({ query, conversationId }) => {
      try {
        return toolSuccess(await recallMemory(api, query, conversationId));
      } catch (error) {
        return toolError(error);
      }
    },
  );
}
