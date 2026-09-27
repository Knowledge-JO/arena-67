import { type AxiosInstance } from 'axios';
import type {
  TokenDetail,
  TokenSearchResult,
  TradeStep,
  TrendingSnapshot,
  WalletStatus,
} from './types.js';

async function searchTokens(
  api: AxiosInstance,
  query: string,
  limit = 8,
): Promise<TokenSearchResult> {
  const { data } = await api.get<TokenSearchResult>('/tokens/search', {
    params: { q: query, limit },
  });
  return data;
}

async function getToken(
  api: AxiosInstance,
  address: string,
): Promise<TokenDetail> {
  const { data } = await api.get<TokenDetail>(`/tokens/${address}`);
  return data;
}

async function getTrending(api: AxiosInstance): Promise<TrendingSnapshot> {
  const { data } = await api.get<TrendingSnapshot>('/research/trending');
  return data;
}

async function getWallet(api: AxiosInstance): Promise<WalletStatus> {
  const { data } = await api.get<WalletStatus>('/trade/wallet');
  return data;
}

async function beginTrade(
  api: AxiosInstance,
  body: {
    intent: {
      action: 'buy' | 'sell';
      ticker?: string;
      contractAddress?: string;
      amount?: number;
      currency?: string;
    };
  },
): Promise<TradeStep> {
  const { data } = await api.post<TradeStep>('/trade/begin', body);
  return data;
}

async function selectPool(
  api: AxiosInstance,
  body: { intentId: string; poolId: string },
): Promise<TradeStep> {
  const { data } = await api.post<TradeStep>('/trade/select-pool', body);
  return data;
}

async function setAmount(
  api: AxiosInstance,
  body: { intentId: string; amount: number },
): Promise<TradeStep> {
  const { data } = await api.post<TradeStep>('/trade/amount', body);
  return data;
}

async function getPortfolio(api: AxiosInstance): Promise<Record<string, unknown>> {
  const { data } = await api.get('/wallet/portfolio');
  return data;
}

async function getTradeHistory(api: AxiosInstance): Promise<unknown[]> {
  const { data } = await api.get('/wallet/trades');
  return data;
}

async function recallMemory(
  api: AxiosInstance,
  query: string,
  conversationId: string,
): Promise<unknown> {
  const { data } = await api.get('/memory/recall', { params: { q: query, conversationId } });
  return data;
}

async function getTokenReport(api: AxiosInstance, address: string): Promise<Record<string, unknown>> {
  const { data } = await api.get(`/research/tokens/${address}/report`);
  return data;
}

async function getTopHolders(
  api: AxiosInstance,
  address: string,
  params: { limit?: number; include?: string[] },
): Promise<Record<string, unknown>> {
  const { data } = await api.get(`/research/tokens/${address}/holders`, {
    params: { limit: params.limit, include: params.include?.join(',') || undefined },
  });
  return data;
}

async function getTopVolume(
  api: AxiosInstance,
  params: { window?: string; limit?: number },
): Promise<Record<string, unknown>> {
  const { data } = await api.get('/research/top-volume', { params });
  return data;
}

async function findCommonHolders(
  api: AxiosInstance,
  body: { tokens: string[]; topN?: number; minTokens?: number; include?: string[] },
): Promise<Record<string, unknown>> {
  const { data } = await api.post('/research/common-holders', body);
  return data;
}

async function getWalletHoldings(api: AxiosInstance, address: string): Promise<Record<string, unknown>> {
  const { data } = await api.get(`/research/wallets/${address}/holdings`);
  return data;
}

export {
  findCommonHolders,
  getTokenReport,
  getTopHolders,
  getTopVolume,
  getWalletHoldings,
  getPortfolio,
  getTradeHistory,
  recallMemory,
  beginTrade,
  getToken,
  getTrending,
  getWallet,
  searchTokens,
  selectPool,
  setAmount,
};
