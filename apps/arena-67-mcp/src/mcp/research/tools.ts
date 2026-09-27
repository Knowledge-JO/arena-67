import { McpServer } from '@modelcontextprotocol/server';
import { type AxiosInstance } from 'axios';
import { z } from 'zod';
import {
  getToken,
  getTrending,
  searchTokens,
} from '../../api/arena/api.arena.js';
import type { TrendingSnapshot } from '../../api/arena/types.js';
import { toolError, toolSuccess } from '../shared/responses.js';

const EVM_ADDRESS = /^0x[a-fA-F0-9]{40}$/;

/**
 * Lookup tools — the half of the product that answers questions.
 *
 * The chat used to run every message through a regex that recognised "buy X"
 * and nothing else, so "what is VLAD", "look up robinhood" and "is 0x883 a
 * token?" all got the same canned reply about buying ANIME. None of those are
 * trades. They are lookups, and they need tools that can actually answer.
 */
export function registerResearchTools(server: McpServer, api: AxiosInstance) {
  server.registerTool(
    'search_tokens',
    {
      title: 'Search tokens by name or ticker',
      description:
        'Find tokens on Robinhood Chain whose symbol or name matches a query. ' +
        'Use this when the user names a token in words ("what is VLAD", "look ' +
        'up robinhood") rather than giving an address. Several tokens can ' +
        'share a ticker, so present the matches and let the user choose rather ' +
        'than assuming the first is correct.',
      inputSchema: {
        query: z.string().min(1).describe('Ticker or name fragment, e.g. "vlad".'),
        limit: z.number().int().min(1).max(25).optional(),
      },
    },
    async ({ query, limit }) => {
      try {
        const result = await searchTokens(api, query, limit ?? 8);
        if (result.results.length === 0) {
          return toolSuccess({
            query,
            candidates: [],
            note:
              'No token on Robinhood Chain matches that name — neither on ' +
              'exchanges nor among recent launches. Say so plainly, and offer to ' +
              'look it up if they have the contract address.',
          });
        }

        // `kind` makes this a step the desk can draw. Eight identical tickers
        // as prose bullets is not a choice a human can make — as cards with
        // cap and volume, ranked, it is. Say which one is which in one line
        // and let the card carry the numbers.
        return toolSuccess({
          kind: 'token_choices',
          query: result.query,
          candidates: result.results,
          note:
            result.results.length > 1
              ? 'These are shown to the user as selectable cards with market ' +
                'cap and volume. Do not list the addresses again — say briefly ' +
                'how they differ and ask which one.'
              : undefined,
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'get_token',
    {
      title: 'Get a token by contract address',
      description:
        'Quick market view for one contract: price, market cap, 24h volume and ' +
        'change, buy/sell counts, website and socials, and the pools it trades ' +
        'on. Also the way to answer "is this address a token?" — a contract ' +
        'that does not respond to ERC-20 calls comes back isToken: false. For a ' +
        'full picture including holders, use get_token_report instead.',
      inputSchema: {
        address: z
          .string()
          .regex(EVM_ADDRESS, 'Must be a 42-character 0x address')
          .describe('The token contract address.'),
      },
    },
    async ({ address }) => {
      try {
        const token = await getToken(api, address);
        if (!token.isToken) return toolSuccess(token);
        if (!token.market) {
          return toolSuccess({
            ...token,
            note:
              'This is a real ERC-20 but no market data exists for it yet. ' +
              'There is no price to report — do not infer one.',
          });
        }
        return toolSuccess(token);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'list_trending',
    {
      title: 'List trending tokens',
      description:
        'The 12 most traded tokens on Robinhood Chain over the last 24 hours, by ' +
        'dollar volume — the same list the app shows as trending. For another ' +
        'window (1h, 6h), more tokens, or the ranked card with a follow-up on ' +
        'holders, use get_top_volume_tokens instead.',
      inputSchema: {},
    },
    async () => {
      try {
        const snap = await getTrending(api);
        return toolSuccess({
          window: snap.window,
          tokens: snap.tokens,
          observedMinutes: snap.observedMinutes,
          stale: snap.stale,
          note: trendingNote(snap),
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );
}

/** Caveats the model should pass on, if any. */
export function trendingNote(snap: TrendingSnapshot): string | undefined {
  if (snap.stale) return 'This list is stale; the backend has not refreshed it recently.';
  if (snap.observedMinutes < 1440) {
    return (
      `The backend has only watched ${snap.observedMinutes} minutes of trading so far, ` +
      'so only tokens traded in that time are ranked. Volume figures themselves are full 24h totals.'
    );
  }
  return undefined;
}
