#!/usr/bin/env node

import { createMcpExpressApp } from '@modelcontextprotocol/express';
import {
  type NodeIncomingMessageLike,
  type NodeServerResponseLike,
  toNodeHandler,
} from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { createApiClient, USER_HEADER } from './api/api.js';
import { env } from './config.js';
import { createArenaServer } from './mcp/server.js';

type ExpressMcpRequest = NodeIncomingMessageLike & {
  body?: unknown;
  headers: Record<string, string | string[] | undefined>;
};
type JsonResponse = NodeServerResponseLike & {
  json: (body: unknown) => unknown;
  status: (code: number) => JsonResponse;
};

function parseCsv(value: string | undefined): string[] | undefined {
  const parsed = value?.split(',').map((v) => v.trim()).filter(Boolean);
  return parsed && parsed.length > 0 ? parsed : undefined;
}

function parsePort(value: string | undefined): number {
  const parsed = Number(value ?? 5100);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`Invalid PORT value: ${value}`);
  }
  return parsed;
}

const host = env('HOST') ?? '0.0.0.0';
const port = parsePort(env('PORT'));
const mcpPath = env('MCP_PATH') ?? '/mcp';
const allowedHosts = parseCsv(env('MCP_ALLOWED_HOSTS'));
const allowedOrigins = parseCsv(env('MCP_ALLOWED_ORIGINS'));
const sharedToken = env('MCP_TOKEN');

const app = createMcpExpressApp({
  host,
  ...(allowedHosts ? { allowedHosts } : {}),
  ...(allowedOrigins ? { allowedOrigins } : {}),
});

/**
 * A shared-secret gate, applied only when MCP_TOKEN is set.
 *
 * Arena's backend has no auth of its own, so there is no token to verify
 * against the way the grape server verifies JWTs — inventing one here would be
 * theatre. This is the honest middle: open by default so local development
 * works, and a real gate the moment a secret is configured. The startup log
 * says which mode is in force, because an MCP server that can read a funded
 * wallet's address should never be quietly public.
 */
function authorize(req: ExpressMcpRequest): boolean {
  if (!sharedToken) return true;
  const header = req.headers['authorization'];
  const value = Array.isArray(header) ? header[0] : header;
  return value?.replace(/^Bearer\s+/i, '').trim() === sharedToken;
}

/**
 * One server instance per HTTP request, built around that request's user.
 *
 * The backend sends a short-lived user token on each call. It is lifted from
 * the request here and baked into the API client, so every tool the model
 * invokes during this request acts for that user and no other. The model
 * never sees the token and no tool accepts a user id as an argument — which is
 * what stops a prompt injection from asking for someone else's portfolio.
 */
const handler = createMcpHandler(
  (ctx) => {
    const userToken = ctx.requestInfo?.headers.get(USER_HEADER) ?? undefined;
    return createArenaServer(createApiClient(userToken));
  },
  { onerror: (error) => console.error('[arena-67-mcp]', error) },
);

const nodeHandler = toNodeHandler(handler, {
  onerror: (error) => console.error('[arena-67-mcp]', error),
});

app.all(mcpPath, (req: ExpressMcpRequest, res: JsonResponse) => {
  if (!authorize(req)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  void nodeHandler(req, res, req.body);
});

app.get('/health', (_req: NodeIncomingMessageLike, res: JsonResponse) => {
  res.json({
    ok: true,
    name: 'arena-67-mcp',
    backend: env('API_URL') || 'http://localhost:9000',
    // Two independent directions: who may call us, and how we identify
    // ourselves to the backend.
    inboundAuth: Boolean(sharedToken),
    backendAuth: Boolean(env('SERVICE_SECRET')),
  });
});

app.listen(port, () => {
  console.error(
    `[arena-67-mcp] listening on :${port}${mcpPath} -> ` +
      `${env('API_URL') || 'http://localhost:9000'} ` +
      `(inbound: ${sharedToken ? 'token' : 'OPEN'}, ` +
      `backend: ${env('SERVICE_SECRET') ? 'identified' : 'anonymous'})`,
  );
});
