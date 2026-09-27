import type {
  AgentReply,
  HolderKind,
  HolderOverlap,
  HoldersBlock,
  HoldersStatus,
  LiveMarket,
  ConversationSummary,
  Me,
  Portfolio,
  StoredMessage,
  TradeStep,
  TradingMode,
  TrendingSnapshot,
  SidebarList,
  SidebarView,
} from './types';

const BASE =
  process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, '') ?? 'http://localhost:9000';

export class ApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

/** Thrown when the session is gone and could not be renewed. */
export class SignedOutError extends ApiError {}

/**
 * Sessions live in httpOnly cookies, which page JavaScript cannot read — that
 * is the point: an XSS bug cannot lift a session that controls a wallet. So
 * every request sends `credentials: 'include'` and lets the browser attach
 * them, and the client never sees or stores a token.
 */
async function raw(path: string, init: RequestInit = {}): Promise<Response> {
  try {
    return await fetch(`${BASE}${path}`, {
      ...init,
      credentials: 'include',
      headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    });
  } catch {
    throw new ApiError('Cannot reach the trading desk. Is the backend running on :9000?');
  }
}

/** One refresh in flight at a time, however many requests hit a 401 at once. */
let refreshing: Promise<boolean> | null = null;

function refresh(): Promise<boolean> {
  refreshing ??= raw('/auth/refresh', { method: 'POST' })
    .then(async (r) => r.ok && ((await r.json()) as { ok: boolean }).ok)
    .catch(() => false)
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

/**
 * The access token lives fifteen minutes. When it lapses mid-conversation the
 * request fails with 401; this renews it once and retries, so an expired token
 * is invisible rather than dumping someone out of a chat they are in.
 */
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res = await raw(path, init);

  if (res.status === 401 && !path.startsWith('/auth/')) {
    if (await refresh()) res = await raw(path, init);
    if (res.status === 401) throw new SignedOutError('Your session ended. Sign in again.', 401);
  }

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string | string[] } | null;
    const msg = Array.isArray(body?.message) ? body?.message.join('; ') : body?.message;
    throw new ApiError(msg || `Request failed (${res.status})`, res.status);
  }
  return res.json() as Promise<T>;
}

const post = <T>(path: string, body: unknown = {}) =>
  request<T>(path, { method: 'POST', body: JSON.stringify(body) });

export const api = {
  // --- auth
  requestCode: (email: string) => post<{ sent: boolean }>('/auth/code', { email }),
  verifyCode: (email: string, code: string) => post<Me & { isNewUser: boolean }>('/auth/verify', { email, code }),
  logout: () => post<{ ok: boolean }>('/auth/logout'),

  /** The signed-in user, or null — never throws for "not signed in". */
  me: async (): Promise<Me | null> => {
    const r = await raw('/auth/me');
    if (r.ok) return r.json() as Promise<Me>;
    if (r.status === 401 && (await refresh())) {
      const again = await raw('/auth/me');
      if (again.ok) return again.json() as Promise<Me>;
    }
    return null;
  },

  // --- sandbox / live
  setMode: (mode: TradingMode) =>
    request<{ mode: TradingMode }>('/account/mode', { method: 'PUT', body: JSON.stringify({ mode }) }),
  sandbox: () => request<Portfolio>('/sandbox'),
  depositPaper: (asset: 'ETH' | 'USDG', amount: string) =>
    post<{ ok: boolean; valueUsd: number; portfolio: Portfolio }>('/sandbox/deposit', { asset, amount }),
  resetSandbox: () => post<{ ok: boolean; portfolio: Portfolio }>('/sandbox/reset'),

  // --- wallet
  balance: () => request<{ address: string; eth: string }>('/wallet/balance'),
  portfolio: () => request<Portfolio>('/wallet/portfolio'),
  requestExportCode: () => post<{ sent: boolean }>('/wallet/export/code'),
  exportKey: (code: string) => post<{ address: string; privateKey: string }>('/wallet/export', { code }),

  // --- conversations
  conversations: () => request<ConversationSummary[]>('/conversations'),
  createConversation: () => post<{ id: string; title: string }>('/conversations'),
  messages: (id: string) => request<StoredMessage[]>(`/conversations/${id}/messages`),

  /** One agent turn. Omit conversationId to start a new conversation. */
  chat: (message: string, conversationId?: string) =>
    post<AgentReply>('/agent/chat', { message, conversationId }),

  // --- trading. Identity comes from the session cookie, never the body.
  selectToken: (intentId: string, candidateId: string) =>
    post<TradeStep>('/trade/select-token', { intentId, candidateId }),
  setAmount: (intentId: string, amount: number) =>
    post<TradeStep>('/trade/amount', { intentId, amount }),
  /** Size as a share of what is held; the backend works out the exact amount. */
  setPercent: (intentId: string, percent: number) =>
    post<TradeStep>('/trade/amount', { intentId, percent }),
  selectPool: (intentId: string, poolId: string) =>
    post<TradeStep>('/trade/select-pool', { intentId, poolId }),
  requote: (intentId: string) => post<TradeStep>('/trade/requote', { intentId }),
  confirm: (intentId: string, quoteId: string) =>
    post<TradeStep>('/trade/confirm', { intentId, quoteId }),

  // --- research (signed in)
  /** Indexing progress only; queues nothing, so cards can poll it. */
  holdersStatus: (tokens: string[]) =>
    request<Array<{ address: string; status: HoldersStatus; progress: number }>>(
      `/research/holders/status?tokens=${tokens.join(',')}`,
    ),
  liveMarket: (address: string) => request<LiveMarket>(`/research/tokens/${address}/live`),
  tokenHolders: (address: string, limit = 10) =>
    request<HoldersBlock & { address: string }>(`/research/tokens/${address}/holders?limit=${limit}`),
  commonHolders: (body: { tokens: string[]; topN?: number; minTokens?: number; include?: HolderKind[] }) =>
    post<HolderOverlap>('/research/common-holders', body),

  // --- research (public)
  sidebar: async (view: SidebarView, limit: number): Promise<SidebarList> => {
    const r = await raw(`/research/sidebar?view=${view}&limit=${limit}`, { cache: 'no-store' });
    if (!r.ok) throw new ApiError('Could not load tokens.');
    return r.json();
  },
  trending: async (): Promise<TrendingSnapshot> => {
    const r = await raw('/research/trending', { cache: 'no-store' });
    if (!r.ok) throw new ApiError('Could not load trending tokens.');
    return r.json();
  },
};
