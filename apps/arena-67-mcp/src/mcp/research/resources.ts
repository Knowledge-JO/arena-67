import { McpServer } from '@modelcontextprotocol/server';
import { type AxiosInstance } from 'axios';
import { getTrending, getWallet } from '../../api/arena/api.arena.js';
import { resourceContents } from '../shared/responses.js';
import { trendingNote } from './tools.js';

/**
 * Resources: state the model can read without deciding to "do" anything.
 *
 * The split from tools is about intent. Asking what is trending is not an
 * action the desk takes on someone's behalf; it is context that is simply
 * true right now. Exposing it as a resource lets a client attach it to a
 * conversation up front, instead of spending a tool round discovering the
 * same thing every time someone opens the chat.
 */
export function registerResearchResources(server: McpServer, api: AxiosInstance) {
  server.registerResource(
    'trending',
    'arena://trending',
    {
      title: 'Trending tokens on Robinhood Chain',
      description:
        'The most traded tokens over the last 24 hours, by dollar volume, with ' +
        'price, 24h change, market cap and launch time where a market exists.',
      mimeType: 'application/json',
    },
    async (uri) => {
      const snap = await getTrending(api);
      return resourceContents(uri, {
        window: snap.window,
        tokens: snap.tokens,
        observedMinutes: snap.observedMinutes,
        stale: snap.stale,
        note: trendingNote(snap),
      });
    },
  );

  server.registerResource(
    'wallet',
    'arena://wallet',
    {
      title: 'Agent wallet status',
      description:
        'Whether the desk can sign, and the agent wallet address. Read this ' +
        'before telling anyone a trade can complete.',
      mimeType: 'application/json',
    },
    async (uri) => resourceContents(uri, await getWallet(api)),
  );
}
