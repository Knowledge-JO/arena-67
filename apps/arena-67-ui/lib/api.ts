import type { TradeIntent, TradeStep, TrendingSnapshot } from './types';

const BASE =
  process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, '') ?? 'http://localhost:9000';

class ApiError extends Error {}

async function post<T>(path: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ApiError(
      'Cannot reach the trading desk. Is the backend running on :9000?',
    );
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new ApiError(detail.slice(0, 200) || `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  wallet: async (): Promise<{ address: string }> => {
    const res = await fetch(`${BASE}/trade/wallet`);
    if (!res.ok) throw new ApiError('Could not read the agent wallet.');
    return res.json();
  },

  begin: (sessionId: string, intent: TradeIntent) =>
    post<TradeStep>('/trade/begin', { sessionId, intent }),

  // Only the opaque id travels — never the address the card displayed.
  selectToken: (sessionId: string, intentId: string, candidateId: string) =>
    post<TradeStep>('/trade/select-token', { sessionId, intentId, candidateId }),

  setAmount: (sessionId: string, intentId: string, amount: number) =>
    post<TradeStep>('/trade/amount', { sessionId, intentId, amount }),

  confirm: (sessionId: string, intentId: string, quoteId: string) =>
    post<TradeStep>('/trade/confirm', { sessionId, intentId, quoteId }),

  trending: async (): Promise<TrendingSnapshot> => {
    const res = await fetch(`${BASE}/research/trending`, { cache: 'no-store' });
    if (!res.ok) throw new ApiError('Could not load trending tokens.');
    return res.json();
  },
};

export { ApiError };
