import { McpServer } from '@modelcontextprotocol/server';
import { type AxiosInstance } from 'axios';
import { z } from 'zod';
import {
  addPaperFunds,
  getMode,
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
        "The signed-in user's portfolio for the mode they are in. In sandbox " +
        '(mode: "sandbox") it is their paper account, with net deposits, total ' +
        'return and profit per holding; in live it is their real wallet. Use when ' +
        'they ask what they hold, their balance, profit, or portfolio. Tokens with ' +
        'no market are listed but excluded from the total — say how many, never ' +
        'value them at zero.',
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
        'Trades the user has made through Arena in their current mode, newest ' +
        'first — paper trades in sandbox, real ones in live. The authority for ' +
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
    'add_paper_funds',
    {
      title: 'Add paper funds to the sandbox',
      description:
        'Adds paper ETH or USDG to the user\'s sandbox account (sandbox mode ' +
        'only; it costs nothing and is not real money). Up to $1,000,000 per ' +
        'top-up. Deposits are not counted as profit. Use when the user asks to ' +
        'add or top up paper funds, or has none and wants to trade in sandbox. ' +
        'There is no tool to switch between sandbox and live — the user does ' +
        'that with the switch in the app.',
      inputSchema: {
        asset: z.enum(['ETH', 'USDG']),
        amount: z.string().regex(/^\d+(\.\d+)?$/, 'A plain number, e.g. "1000" or "0.5"'),
      },
    },
    async ({ asset, amount }) => {
      try {
        const { mode } = await getMode(api);
        if (mode !== 'sandbox') {
          return toolError(
            new Error(
              'The user is in Live mode. Paper funds only exist in Sandbox — they can switch at the top of the app.',
            ),
          );
        }
        const result = await addPaperFunds(api, { asset, amount });
        // Returned as the portfolio card, so the new balance is on screen.
        return toolSuccess((result as { portfolio: unknown }).portfolio ?? result);
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
