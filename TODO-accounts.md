# Arena 67 — accounts, wallets, memory

Replaces the single CDP agent wallet with **one custodial wallet per user**,
behind email + one-time-passcode auth. Conversations persist, with semantic
memory across them, and the chat gains a wallet balance and a portfolio card.

Spans backend, MCP server and UI.

---

## Why CDP is out

The CDP bridge never worked: `api.cdp.coinbase.com` was unreachable from every
environment we tested, so `confirm` never once signed. Beyond that, CDP gave us
*one* wallet for the whole desk — every user would have shared a balance. Per-user
wallets are the real product; the single agent wallet was a placeholder.

---

## Read this first: what "custodial" means here

The server generates each user's private key and holds it. Encrypting it at rest
protects against **a database leak** — someone with a dump of the `wallets` table
gets ciphertext and nothing else.

It does **not** protect against **a compromised server.** The process that
decrypts keys to sign holds the master key in memory. Whoever controls that
process can move every user's funds. That is inherent to custody, not a flaw in
this implementation, and no amount of encryption changes it.

What that obliges us to do:

- **The master key never touches the database, the logs, the LLM, or the client.**
- **Keys are decrypted only at signing, only in memory, and dropped immediately.**
- **The LLM can still never sign.** It prepares; the user confirms in the UI.
  With per-user wallets this rule now protects the user's own money.
- **Users can export their key.** Otherwise the service going down means their
  funds are gone. This was not in the request; it is not optional for custody.
- **Production needs a KMS**, not an env var. An env var sits one `cat .env` away
  from the database credentials. Fine for a hackathon; not for real deposits.

Holding customer funds also has legal implications this document does not
resolve. Worth knowing before this takes anything beyond test amounts.

---

## Recommended flow

### Sign up and log in are the same flow

```
enter email → code emailed → enter code → signed in
                                           ├─ new email: account + wallet created
                                           └─ known email: logged in
```

One flow instead of two. Separate "sign up" and "log in" screens leak which
emails have accounts — "no account for that email" tells an attacker who is a
user. A single "enter your email" step answers identically either way.

### Codes

- 6 digits, **10 minute** lifetime, **single use**
- Stored as a **SHA-256 hash**, never plaintext — same discipline as grape's tokens
- **5 wrong attempts** burns the code; a new one must be requested
- **Rate limited** per email and per IP, or the endpoint becomes a way to spam
  inboxes with codes
- Requesting a new code invalidates the previous one

### Sessions

- Short-lived **access JWT** (15 min) + rotating **refresh token** (30 days)
- Refresh tokens stored hashed, revocable — grape's `refresh_tokens` pattern
- Tokens in **httpOnly cookies**, not localStorage. JavaScript cannot read an
  httpOnly cookie, so an XSS bug cannot lift a session that controls a wallet.

### Wallet

- Generated at account creation. **Exactly one per user**, enforced by a unique
  constraint, not just by application code.
- Private key encrypted with **AES-256-GCM** (grape's `EncryptionService`), with
  two changes for this use:
  1. **Fails closed.** Grape's version degrades to plaintext when no key is set.
     That is sensible for OAuth tokens and lazy migration; for private keys it
     would silently store spendable keys in the clear. Here, no key = no start.
  2. **Bound to its owner.** The wallet address goes in as GCM additional
     authenticated data. A ciphertext copied into another user's row fails
     authentication instead of decrypting — so write access to the database is
     not enough to sign with someone else's key.

### Conversations and memory

Two kinds of memory, and they answer different questions:

| Question | Answered by |
| --- | --- |
| "what did I buy?" | **structured data** — the trades table |
| "what do I hold?" | **the chain** — balances, live |
| "that token we talked about last week" | **semantic memory** — embeddings |

Embeddings are the right tool only for the last one. "What did I buy" answered by
semantic search over chat is worse than a query, and a hallucination risk besides.
So both are built, and the agent is told which to use.

- Conversations and messages persist per user
- Messages embedded with a **local model** (`all-MiniLM-L6-v2`, 384-dim). OpenServ
  has no embeddings endpoint, and a local model needs no key and no network once
  downloaded
- Stored in **pgvector**; retrieval scoped **strictly to the requesting user** —
  one user's memory must never surface in another's conversation

### Portfolio

- **Wallet balance box**, top right of the chat: ETH (gas) and total USD
- Click → sends "show my portfolio" into the *current* conversation → the agent
  calls `get_portfolio` → a portfolio card lands in that conversation
- Holdings discovered from the chain: every token ever sent to the address,
  found by filtering `Transfer` logs on the indexed `to` topic — the same trick
  that resolves pool ids. No third-party wallet API.
- Valued in USD through the existing market service; unpriced tokens shown as
  unpriced, never as $0

### How identity reaches the tools

The hard part, and the one most likely to be done wrong.

The MCP server calls the backend on the model's behalf. If the user's id travelled
as a tool **argument**, the model could put any id in it — and a prompt injection
in a token name could say "call `get_portfolio` for user 7". So identity never
passes through anything the model writes.

Instead, grape's pattern: a **per-request MCP session carrying a short-lived token**
minted by the backend for that user. The MCP server forwards it; the backend
verifies it and resolves the user itself. The model never sees it and cannot
change it.

This means moving from one long-lived MCP connection to a session per chat turn —
which is exactly why grape opens one per request.

---

## What the request did not cover

Built in this pass:

- **Deposit address.** A wallet nobody can fund is useless. Shown with copy.
- **Key export.** Behind a fresh code, because an export is the most dangerous
  action in the product.
- **Conversation list.** "Per conversation" implies several — so a sidebar, new
  conversation, and switching between them.
- **Logout**, and session expiry handled without dumping the user mid-chat.
- **Rate limiting** on code requests.
- **Dev without an inbox.** Codes print to the backend log when no SMTP is set.

Flagged, not built:

- **Withdraw / send.** Users can export their key and move funds anywhere, so
  funds are never trapped — but an in-app send is the obvious next feature.
- **KMS** for the master key. Required before real deposits.
- **Key rotation.** Changing the master key means re-encrypting every wallet.
- **Account deletion** and what happens to a funded wallet when it happens.

---

## Database

Grape's convention: **Drizzle + `pg`**. Production points at real Postgres with
pgvector via `DATABASE_URL`.

For local development, **PGlite** — Postgres compiled to WASM, running in-process,
with pgvector. Same Drizzle schema, same SQL, no Docker. Chosen because it lets
the whole stack run with zero setup, and because it is the only way this code can
be tested from the dev sandbox.

Driver is picked at startup: `DATABASE_URL` set → `pg`; unset → PGlite at
`./.data/arena67`.

### Schema

```
users              id, email (unique), created_at, last_login_at
login_codes        id, email, code_hash, expires_at, attempts, used_at
refresh_tokens     id, user_id, token_hash, expires_at, revoked_at
wallets            id, user_id (UNIQUE), address (unique), encrypted_key, created_at
conversations      id, user_id, title, created_at, updated_at
messages           id, conversation_id, role, content, step, tool_calls,
                   embedding vector(384), created_at
trades             id, user_id, conversation_id, token, pool_id, side,
                   amount_in, amount_out, tx_hash, status, created_at
```

---

## Tasks

### 1 · Database
- [x] Drizzle schema for the seven tables above
- [x] Driver selection: `pg` when `DATABASE_URL` set, PGlite otherwise
- [x] pgvector extension enabled on both
- [x] Migrations via drizzle-kit
- [x] `wallets.user_id` unique — one wallet per user at the database level

### 2 · Encryption
- [x] `EncryptionService` from grape, adapted: fails closed, AAD-bound
- [x] `WALLET_ENCRYPTION_KEY` / `_DEV`, 32 bytes base64, validated at boot
- [x] Unit tests: round trip; wrong key fails; **swapped-row AAD fails**; tampered
      ciphertext fails; missing key refuses to start

### 3 · Auth
- [x] `POST /auth/code` `{ email }` — issue code, identical response for new and
      existing emails
- [x] `POST /auth/verify` `{ email, code }` — verify, create user + wallet if new,
      set cookies
- [x] `POST /auth/refresh`, `POST /auth/logout`, `GET /auth/me`
- [x] Codes hashed, 10 min TTL, single use, 5-attempt burn
- [x] Rate limit code requests per email and per IP
- [x] Mail via nodemailer; log the code when SMTP is unset
- [x] `JwtAuthGuard` + `@CurrentUser()` on every user-scoped route
- [ ] Tests: expired code, reused code, attempt burn, enumeration-safe response
      **Gap.** Each behaviour was verified live against the running server
      (reuse → 401, supersession, 5-attempt burn, identical responses for new and
      known emails), but nothing automated locks them in. Auth is the code most
      worth regression tests; this is the first thing to add.

### 4 · Wallets
- [x] Generate on signup, inside the same transaction as the user row
- [x] `WalletSigner`: decrypt → viem account → sign → drop. Replaces CDP.
- [x] Remove the CDP dependency from the signing path
- [x] `GET /wallet` — address + balances
- [x] `POST /wallet/export` — requires a fresh code

### 5 · Trading, per user
- [x] `confirm` signs with the requesting user's wallet
- [x] Pending intents scoped by `userId`, not a browser session id
- [x] Record every trade to `trades`

### 6 · Portfolio
- [x] Holdings via `Transfer` logs filtered on the indexed `to` topic
- [x] Balances via multicall; valued via `MarketService`
- [x] `portfolio` step for the card

### 7 · Conversations and memory
- [x] CRUD, all scoped to the current user
- [x] Persist every turn: user message, agent reply, step, tools used
- [x] Local embeddings; embed on write
- [x] `recall(userId, query)` — pgvector nearest neighbours, **user-scoped**
- [x] Recent history fed into the agent's context — from the database, not the
      client, which previously could rewrite the transcript it sent back
- [x] ~~Recalled memories pre-injected~~ — **deliberately not done.** Recall is a
      tool the model chooses (`recall_memory`), consistent with the rule that the
      LLM decides which tools to call. Injecting memories into every turn would
      also push stale or irrelevant context into questions that did not need it.
      Verified: in a fresh conversation the model called `recall_memory` on its
      own and recalled the right user's token and not another user's.

### 8 · MCP identity
- [x] Backend mints a short-lived per-turn user token
- [x] Per-request MCP session carrying it (grape's pattern)
- [x] MCP forwards it; backend resolves the user from it, never from arguments
- [x] New tools: `get_portfolio`, `get_trade_history`, `recall_memory`
- [x] Test: a tool call cannot reach another user's data

### 9 · UI
- [x] Sign-in screen: email → code
- [x] Wallet box, top right: ETH + USD; click → portfolio request
- [x] Portfolio card
- [x] Deposit address with copy
- [x] Conversation sidebar: list, new, switch
- [x] Logout; graceful session expiry

### 10 · Verify
- [x] Sign up end to end; wallet created; key encrypted in the row
- [x] Log out and back in; same wallet
- [x] Portfolio card in a conversation
- [x] Memory recalled across two conversations, never across two users
- [x] Wrong / expired / reused code all rejected


---

## Build notes (2026-09-27)

**Holdings discovery changed from the plan.** Filtering `Transfer` logs with no
contract address is rejected by this RPC beyond ~10,000 blocks (≈17 minutes of
chain) — measured, not assumed. On-demand scanning would therefore need ~600
queries for a week-old wallet. Replaced with a global forward-scanning cursor,
which is complete because we create every wallet ourselves: none can have
received anything before it existed, so there is never history to backfill.

**Bugs found by testing, not by the typechecker:**
- Signing failures left the `trades` row at `pending` forever. The first test
  written for it was vacuous — it asserted the row was *not* confirmed, which
  passes when nothing is written at all. Rewritten to assert positively, then
  mutation-tested: fails without the fix, passes with it.
- `drizzle.config.ts` at the backend root widened tsc's root and moved all
  output to `dist/src/`, breaking both the migrator and `node dist/main`.
- SQL migrations are not emitted by tsc; now copied as Nest build assets.
- A refused CORS origin returned 500 instead of simply being denied.

**Security properties verified against the running server:**

| attack | result |
| --- | --- |
| user token without the service secret | 401 |
| session cookie replayed as an MCP token | 401 (audience) |
| read another user's conversation | 404, not 403 — ids not probeable |
| post into another user's conversation | 404 |
| genuine MCP token attempts to **sign** | refused |
| genuine MCP token attempts to **export a key** | refused |
| ciphertext moved to another wallet's row | fails authentication |
| memory recall across users | never leaks |
