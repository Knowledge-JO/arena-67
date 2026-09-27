import { McpServer } from '@modelcontextprotocol/server';
import { type AxiosInstance } from 'axios';
import { z } from 'zod';
import {
  findCommonHolders,
  getTokenReport,
  getTopHolders,
  getTopVolume,
  getWalletHoldings,
} from '../../api/arena/api.arena.js';
import { toolError, toolSuccess } from '../shared/responses.js';

const EVM_ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const address = (what: string) =>
  z.string().regex(EVM_ADDRESS, 'Must be a 42-character 0x address').describe(what);
const LABELS = z.enum(['wallet', 'pool', 'burn', 'token', 'contract']);

/**
 * Research beyond a price: full reports, who holds what, what is trading,
 * and who holds several of the same tokens.
 *
 * Holder data comes from an index the backend builds from each token's
 * Transfer history. A token nobody has asked about yet is still being counted
 * the first time — every tool here says so in `status` rather than returning
 * an empty list that would read as "no holders".
 */
export function registerAnalysisTools(server: McpServer, api: AxiosInstance) {
  server.registerTool(
    'get_token_report',
    {
      title: 'Full report on a token',
      description:
        'Everything known about one token, in one call: price, market cap, FDV, ' +
        'liquidity, volume (5m/1h/6h/24h), buys vs sells, price change, age, ' +
        'socials, where it trades, total supply, contract owner, holder count, ' +
        'top holders labelled (wallet / liquidity pool / burn / contract), how ' +
        'concentrated it is, and plain-language "signals" worth knowing. Use this ' +
        'for "what do you know about X", "tell me about X", "is X safe", "who holds ' +
        'X". Needs an address: if you only have a name, call search_tokens first. ' +
        'If holders.status is not "ready", the holder figures are still being ' +
        'counted — say so and report everything else.',
      inputSchema: { address: address('The token contract address.') },
    },
    async ({ address: a }) => {
      try {
        return toolSuccess(await getTokenReport(api, a));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'get_top_holders',
    {
      title: 'Top holders of a token',
      description:
        'The largest holders of one token with their share of total supply, each ' +
        'labelled wallet, pool (liquidity — not a person), burn, token (its own ' +
        'contract) or contract (lockers, vesting, launchpads). Balances are read ' +
        'live from the chain. Pass include:["wallet"] for people only. Use when the ' +
        'user asks for more holders than the report shows, or only about holders.',
      inputSchema: {
        address: address('The token contract address.'),
        limit: z.number().int().min(1).max(100).optional().describe('How many (default 10).'),
        include: z.array(LABELS).optional().describe('Only these kinds of holder.'),
      },
    },
    async ({ address: a, limit, include }) => {
      try {
        return toolSuccess(await getTopHolders(api, a, { limit, include }));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'get_top_volume_tokens',
    {
      title: 'Tokens with the most trading volume',
      description:
        'Tokens on Robinhood Chain ranked by USD trading volume over the last ' +
        'hour, 6 hours or 24 hours (default 24h). Use for "what is trading the ' +
        'most", "high volume tokens today", "what\'s hot", and as the first step of ' +
        'questions about the top tokens\' holders. Candidates are tokens whose ' +
        'Uniswap v4 pools swapped in the observed window (observedMinutes); volume ' +
        'figures are full 24h totals across every exchange. Several tokens can ' +
        'share a symbol — tell them apart by address.',
      inputSchema: {
        window: z.enum(['h1', 'h6', 'h24']).optional(),
        limit: z.number().int().min(1).max(20).optional().describe('How many (default 10).'),
      },
    },
    async ({ window, limit }) => {
      try {
        return toolSuccess(await getTopVolume(api, { window, limit }));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'find_common_holders',
    {
      title: 'Addresses holding several of these tokens',
      description:
        'Given 2–20 token addresses, finds addresses among each token\'s top ' +
        'holders that hold more than one of them. The comparison is done in code: ' +
        'report its result, never work out overlaps yourself. By default only ' +
        'wallets are compared — liquidity pools, burn addresses and contracts are ' +
        'excluded, because the shared Uniswap pool contract would otherwise match ' +
        'every token. Tokens whose holders are still being counted are left out ' +
        'and listed with their progress; say which, and that asking again later ' +
        'will include them. Typical use: get_top_volume_tokens, then pass those ' +
        'addresses here.',
      inputSchema: {
        tokens: z.array(address('Token address.')).min(2).max(20),
        topN: z
          .number()
          .int()
          .min(5)
          .max(100)
          .optional()
          .describe('How many top holders of each token to compare (default 50).'),
        minTokens: z
          .number()
          .int()
          .min(2)
          .optional()
          .describe('Minimum number of the tokens an address must hold (default 2).'),
        include: z.array(LABELS).optional().describe('Kinds of holder to compare (default wallets).'),
      },
    },
    async (args) => {
      try {
        return toolSuccess(await findCommonHolders(api, args));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'get_wallet_holdings',
    {
      title: 'What an address holds',
      description:
        'The tokens a given address holds, with amounts, share of each supply and ' +
        'USD value where priced — among tokens Arena 67 has indexed (count in ' +
        'indexedTokens), not every token on the chain. Also says whether the ' +
        'address is a wallet or a contract. Use for "what does 0x… hold" or to ' +
        'follow up on an address from a holder list. For the signed-in user\'s ' +
        'own wallet use get_portfolio instead.',
      inputSchema: { address: address('The wallet or contract address.') },
    },
    async ({ address: a }) => {
      try {
        return toolSuccess(await getWalletHoldings(api, a));
      } catch (error) {
        return toolError(error);
      }
    },
  );
}
