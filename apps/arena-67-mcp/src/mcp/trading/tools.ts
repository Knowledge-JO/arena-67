import { McpServer } from '@modelcontextprotocol/server';
import { type AxiosInstance } from 'axios';
import { z } from 'zod';
import {
  beginTrade,
  getWallet,
  selectPool,
  setAmount,
} from '../../api/arena/api.arena.js';
import { toolError, toolSuccess } from '../shared/responses.js';

const EVM_ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const POOL_ID = /^0x[a-fA-F0-9]{64}$/;

/**
 * Trade preparation — everything up to, but not including, the signature.
 *
 * There is deliberately no `confirm_trade` tool here, and that absence is the
 * design rather than an omission. The product's one hard rule is that nothing
 * is signed until a human agrees to a specific quote, and a tool an LLM can
 * call on its own turn is precisely a way to sign without one. A prompt that
 * talks the model into "just confirm it" would move real money.
 *
 * So the model can research a token, pick a venue and fetch a price — all
 * reversible, all free — and then hands back a quote id. The confirm lives in
 * the UI, where a person looks at the guaranteed minimum and clicks.
 */
export function registerTradingTools(server: McpServer, api: AxiosInstance) {
  server.registerTool(
    'get_wallet_status',
    {
      title: 'Check the agent wallet',
      description:
        'Whether the desk can sign at all, and the agent wallet address. When ' +
        'available is false the desk is read-only: research and quotes work, ' +
        'signing does not. Check this before promising a user a trade can go ' +
        'through.',
      inputSchema: {},
    },
    async () => {
      try {
        return toolSuccess(await getWallet(api));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'prepare_trade',
    {
      title: 'Start a trade and get the token page',
      description:
        'Opens a trade for a token and returns its page: identity, market ' +
        'stats and the venues it can be traded on. Supply contractAddress when ' +
        'you know it — a ticker may match several tokens and will return a ' +
        'disambiguation list instead. Returns an intentId used by the ' +
        'following steps. Nothing is spent by calling this.',
      inputSchema: {
        action: z.enum(['buy', 'sell']),
        contractAddress: z.string().regex(EVM_ADDRESS).optional(),
        ticker: z.string().optional().describe('Only if no address is known.'),
        amount: z.number().positive().optional(),
        currency: z.string().optional(),
      },
    },
    async ({ action, contractAddress, ticker, amount, currency }) => {
      if (!contractAddress && !ticker) {
        return toolError(new Error('Give either contractAddress or ticker.'));
      }
      try {
        return toolSuccess(
          await beginTrade(api, {
            intent: { action, contractAddress, ticker, amount, currency },
          }),
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'select_pool',
    {
      title: 'Choose which pool to trade through',
      description:
        'Pins the venue for a trade. The poolId must be one listed on the ' +
        'token page — the backend rejects anything else and verifies the pool ' +
        'actually trades that token. The other side of the chosen pool becomes ' +
        'what a buy spends, so picking the USDG pool means spending USDG.',
      inputSchema: {
        intentId: z.string().uuid(),
        poolId: z.string().regex(POOL_ID, 'Must be a 32-byte pool id'),
      },
    },
    async (args) => {
      try {
        return toolSuccess(await selectPool(api, args));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'get_quote',
    {
      title: 'Price the trade',
      description:
        'Sets the amount and returns a quote: what is spent, what comes back, ' +
        'and the guaranteed minimum after slippage. The guaranteed minimum is ' +
        'the number that binds on-chain — quote it to the user, not the ' +
        'expected fill. Quotes expire after 30 seconds.\n\n' +
        'This does NOT sign anything. Give the user the quoteId and let them ' +
        'confirm in the app; there is no tool here that spends funds.',
      inputSchema: {
        intentId: z.string().uuid(),
        amount: z.number().positive().describe('Denominated in the pool\'s quote asset.'),
      },
    },
    async (args) => {
      try {
        const step = await setAmount(api, args);
        return toolSuccess({
          ...step,
          note:
            step.kind === 'confirm'
              ? 'Quote only. Signing happens when the user confirms in the app.'
              : undefined,
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );
}
