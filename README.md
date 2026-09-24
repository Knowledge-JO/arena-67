# Arena 67

A chat-driven trading desk for Uniswap v4 pools: a small language model reads
your intent, the desk prices it, and asks for explicit confirmation before
anything touching the wallet.

Built with a Turborepo monorepo. Two apps:

- `apps/arena-67-backend` - NestJS desk on port 9000. Owns the agent wallet,
  the pending-intent store, quotes, and execution. It uses a Coinbase CDP
  TEE-held signer and swaps through the Uniswap Universal Router (Permit2).
- `apps/arena-67-ui` - Next.js 16 chat interface on port 3000. It speaks to
  the backend over a small REST API and never sees wallet keys or private
  addresses.

There is also a shared `@repo/ui` package, used by the UI.

## Safety model

The desk treats every trade as untrusted until the user confirms it.

- Intent ids, candidate ids, and quote ids are opaque. The backend never
  lets the UI hand back an address learned from a card.
- Pending intents live in a server-side store keyed by session. Only the
  session that created an intent may advance or read it.
- Quotes are short-lived (TTL) and bound to one intent. A quote can only be
  confirmed by the same session through its opaque quote id.
- `claimForExecution` on the store is idempotent, so a double confirm cannot
  fire two swaps.
- `MAX_TRADE_USD` caps the dollar value of any single trade. `MAX_SLIPPAGE_BPS`
  caps how far the fill may move from the quote.
- The default network is mainnet: on mainnet every confirmed trade moves real
  funds. For development use the testnet.

## Prerequisites

- Node 24.9+ (npm is pinned in `devEngines`)
- A Coinbase CDP wallet with an API key (for the testnet / mainnet signer)
- Rust is not required; the Solana/`secp256k1` native modules are prebuilt

Install once from the repo root:

```sh
npm install
```

## Setup

Copy the backend env scaffold and fill in the secrets:

```sh
cp apps/arena-67-backend/.env.example apps/arena-67-backend/.env
```

The variables:

| Variable | Meaning |
| --- | --- |
| `ARENA_NETWORK` | `mainnet` (4663, real funds, default) or `testnet` (46630) |
| `RPC_URL` | Override the network RPC endpoint |
| `MAX_TRADE_USD` | Per-trade dollar cap (default `25`) |
| `MAX_SLIPPAGE_BPS` | Slippage tolerance on quote fills (default `300`) |
| `ENABLE_OPENSERV_AGENT` | When `true`, wires the OpenServ agent into the desk |
| `OPENSERV_AI_API_KEY` | OpenServ SDK key, needed only for the agent path |
| `CDP_API_KEY_ID` / `CDP_API_KEY_SECRET` | Coinbase CDP API credentials |
| `CDP_WALLET_SECRET` | The encrypted CDP wallet secret |
| `AGENT_ACCOUNT_NAME` | Name to use for the agent account (default `arena67-agent`) |

For the testnet desk, set `ARENA_NETWORK=testnet` and fund the agent wallet via
the testnet faucet, then get the wallet address from
`GET http://localhost:9000/trade/wallet`.

## Develop

Backend (watch mode):

```sh
npm run start:dev --workspace=apps/arena-67-backend
```

UI (watch mode):

```sh
npm run dev --workspace=apps/arena-67-ui
```

The UI talks to `http://localhost:9000` by default. To point it elsewhere, set
`NEXT_PUBLIC_API_URL` in the UI environment.

## Test

```sh
npm test --workspace=apps/arena-67-backend
```

The suite covers the pending-intent store (opaque ids, session ownership, TTL,
claim idempotency, sweep) and the trading service (amount validation, the USD
cap, funding selection, the quote-then-confirm flow, double-confirm being a
no-op, wallet-offline behaviour).

## Build

```sh
npm run build --workspace=apps/arena-67-backend
npm run build --workspace=apps/arena-67-ui
```

## Monorepo tools

```sh
npx turbo build --filter=arena-67-backend
npx turbo build --filter=arena-67-ui
```