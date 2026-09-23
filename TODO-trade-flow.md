# Arena 67 — trade flow v2

Token page with real market data → pick a pool → amount → quote → sign.
Spans both apps.

**Deadline: Sept 28, 00:00 UTC.** `[stretch]` items get cut first.

---

## What changed and why

v1 resolved a ticker, guessed at pools, and jumped straight to an amount. Three
things were wrong with that:

1. **Clicking a pane row threw away the address** and re-searched by ticker.
2. **No token context.** You were asked to commit money to a contract address
   with no price, no size, no idea whether anyone else was trading it.
3. **Pool discovery was blind.** The index covers a rolling ~5.6h window
   (200,000 blocks at this chain's 0.101s block time), so it only ever saw
   recently-created pools.

That third one is not theoretical. microduck's **largest** pool — $180k
liquidity — was created at block 47,419,181 against a hook at
`0xE5e70264…`, with `fee 0 / tickSpacing 200`. The index has never seen it and
tier-probing cannot construct it. We were routing around the best pool.

---

## Data sources

### Dexscreener — discovery and market data

`GET https://api.dexscreener.com/latest/dex/tokens/{address}` covers this chain
as `chainId: "robinhood"`. Verified against microduck: **30 pairs returned**,
every one carrying `info`.

Per pair: `priceUsd`, `fdv`, `marketCap`, `liquidity.usd`, `volume{m5,h1,h6,h24}`,
`txns{buys,sells}`, `priceChange`, `pairCreatedAt`, `labels:["v4"]`, and
`info{imageUrl, header, websites[], socials[]}`.

**`pairAddress` is the 32-byte v4 poolId**, not a 20-byte address.

### On-chain — the authority for anything we sign

Dexscreener tells us *which* pools exist and how big they are. It never tells us
what to sign. Every quote and every swap is built from a `PoolKey` recovered
from chain state.

**poolId → PoolKey**: `Initialize` declares `id` as an indexed topic, so a
single `getLogs` filtered on it resolves any pool over the full range in
**~1.9s** — no backfill required. Cache the result; a PoolKey is immutable.

---

## Target flow

```
pane click  ─┐
address typed ├─→ TOKEN PAGE ─→ pick pool ─→ amount ─→ quote ─→ sign
ticker typed ─┴─→ candidates ─┘
```

**The token page** carries what you need to decide:

- header — image, name, symbol, full address, website + socials
- stats — price USD, market cap / FDV, 24h volume, 24h change, buys vs sells
- **pools** — one row per quote asset, the deepest pool for each

Deduping by quote asset is what makes the list readable. microduck's 30 pairs
become 3 tradeable rows — 6 are v2/v3 and drop out first, then the remaining 24
v4 pools collapse by quote asset:

```
microduck/NVDA   $180,717   (1 pool)
microduck/USDG   $ 73,706   (best of 4)
microduck/ETH    $ 50,589   (best of 19)
```

Ticker input is **the only path that disambiguates**. An address or a pane
click goes straight to the token page.

If the user gave an amount up front (`buy 0.001 ETH of microduck`), still show
the token page — they now have a pool to choose, which they didn't before — but
pre-fill the amount so it's one click to a quote.

---

## Contract changes

### `token_detail` replaces `need_amount`

```ts
| { kind: 'token_detail'
    intentId: string
    token: { address, symbol, name, decimals, imageUrl?, websites[], socials[] }
    stats?: { priceUsd, marketCap, fdv, volume24h, priceChange24h, buys24h, sells24h }
    pools: Array<{
      poolId, quoteSymbol, quoteAddress, quoteDecimals,
      liquidityUsd, priceUsd, poolCount        // how many were collapsed into this row
    }>
    message: string }
```

`stats` is **optional**. It comes from a third party that can be down, rate
limited, or simply have no record of a token minted ten minutes ago. Absent
means absent — render the page without it rather than showing zeros. Same rule
that keeps `priceImpactBps` off the confirm card.

### New endpoints

```
POST /trade/select-pool  { sessionId, intentId, poolId }  -> TradeStep
POST /trade/requote      { sessionId, intentId }          -> TradeStep
GET  /tokens/:address                                      -> token page payload
```

`/trade/requote` re-prices **the same pool** and issues a new `quoteId`,
invalidating the previous one so a stale card in another tab cannot be
confirmed.

### Quoting targets one pool

`QuoteService.quoteExactIn` currently races every candidate and keeps the best
fill. Once the user has picked a pool, that is wrong — it could silently route
through a different one than the page showed. Add an explicit `pool` argument;
when present, quote that pool only.

### Still load-bearing

The client echoes `intentId` / `poolId` / `quoteId`. The server re-reads amount,
token, pool and funding asset from its own store before signing.

**A contract address arriving from the client is not a regression of that rule.**
Choosing what to buy has always been the user's call and `/trade/begin` has
always accepted an address. The rule is that the client cannot change the target
*after* a quote exists, and the pending-intent store still enforces that.

---

## Tasks

### 1 · Backend — market data
- [x] `DexscreenerService`: fetch by token address, 10s timeout, typed response
- [x] Cache ~30s per token; never let a slow upstream block a page render
- [x] Collapse pairs → one row per `quoteToken.address`, max `liquidity.usd`
- [x] Sort rows by liquidity desc; cap at 6
- [x] Degrade to the on-chain index when Dexscreener returns nothing (new token)
- [x] Treat every field as untrusted input — it is third-party data, not truth

**Done 2026-09-23.** `MarketService` + zod-parsed `dexscreener.schema.ts`.
Verified offline against a captured payload: microduck's 30 pairs → 3 rows,
with socials, FDV $4.3M, 24h volume $390k, buys/sells 1315/1276.

**Filter finding — v2/v3 pools are excluded, deliberately.** Only 24 of those
30 pairs are v4 (a 66-char `pairAddress` is a poolId; 42 chars is a v2/v3 pair
address). Our swap path is the v4 UniversalRouter, so a v3 pool is not
tradeable here and showing it would offer a venue we cannot route through.
This is why WETH and PONS do not appear for microduck — they exist only as v3
pools. Real liquidity we are leaving on the table: ~$104k across six v3/v2
pools. Supporting them needs `V3_SWAP_EXACT_IN` (0x00) and a separate path.
- [ ] `[stretch]` v3 routing via `V3_SWAP_EXACT_IN`

**Retry added** beyond the plan: this host's connections fail intermittently at
the transport layer, and one blip would otherwise drop a token to its
chain-only view for a whole cache window. 4xx is treated as an answer, not a
blip, so it is not retried.

### 2 · Backend — PoolKey resolution
- [x] `PoolIndexService.resolveById(poolId)`: indexed-topic `getLogs`, full range
- [x] Cache resolved PoolKeys indefinitely (immutable)
- [x] Check the in-memory index first; only hit the chain on a miss
- [x] Reject a poolId whose recovered pair doesn't match the intent's token —
      a mismatched id must never reach a swap

**Done 2026-09-23.** `resolveById` + `resolveForToken` on `PoolIndexService`.
Verified live: cold resolve of microduck's hooked NVDA pool (block 47,419,181,
`fee 0 / tickSpacing 200`) took **3.0s**, cached re-read **0ms**, a mismatched
token was rejected, and an unknown id returned null.

RPC failure **throws** rather than returning null, so "the chain says no such
pool" and "we could not ask" stay distinguishable — otherwise a network blip
gets cached as a permanent negative.

### 3 · Backend — flow
- [x] `token_detail` step; delete `need_amount`
- [x] `/trade/begin` with `contractAddress` reaches `token_detail` in one trip
- [x] `POST /trade/select-pool` → stores chosen pool → `need_amount` state
- [x] `/trade/amount` quotes **the chosen pool only**
- [x] `POST /trade/requote` — allowed from `quoted`, refused once `executing`
- [x] Persist chosen pool on the intent so `confirm` signs what was quoted

**Done 2026-09-23.** Verified against mainnet, one session end to end:

```
begin(address)        -> token_detail, 1 trip
                         microduck $0.004575, cap $4.58M, vol24h $379k, +10.35%
                         socials + image present, degraded=false
                         microduck/NVDA $188,330 (+0)
                         microduck/USDG $ 75,301 (+3 hidden)
                         microduck/ETH  $ 51,857 (+18 hidden)
select-pool(USDG)     -> venue pinned, prompt becomes "How much…"
amount(5)             -> confirm: spend 5 USDG, ~1084.9 microduck,
                         guaranteed min 1052.4, fee 0.78%, venue microduck/USDG
requote               -> new quoteId issued
```

**Funding now comes from the venue, not from preferences.** The other side of
the chosen pool *is* what a buy spends — `pickFunding`'s pool search could name
an asset the selected pool does not trade. Decimals come from the network's
known base assets, or are read from the contract.

**Guards re-verified directly** (the live `confirm` test was inconclusive — the
wallet-offline check fires first and masks quote validation):

| case | result |
| --- | --- |
| correct quote id | claimed |
| same id replayed | refused, idempotent |
| stale id after requote | rejected |
| new id after requote | claimed |
| quote older than 30s | rejected |
| cross-session read | rejected |

Also: `selectPool` refuses any poolId not listed on the page, then
`resolveForToken` proves the pool trades this token before it is pinned.

### 4 · Backend — trending pane
- [ ] **Exclude WETH / USDG / native ETH** — they are quote assets and currently
      occupy the top two rows of a list nobody opens to buy dollars
- [ ] Enrich the top N with Dexscreener price + 24h change
- [ ] Research cron 5 min → ~60s
- [ ] `[stretch]` rank by real 24h volume instead of pool count

### 5 · UI — token page card
- [ ] Header: image, name, symbol, copyable address, website + socials links
- [ ] Stat row: price, market cap, 24h volume, 24h change (green/red), buys/sells
- [ ] Pool rows: `SYMBOL/QUOTE`, liquidity, price, "+3 smaller pools" hint
- [ ] Selecting a pool reveals the amount input inline
- [ ] Amount input: funding symbol from the chosen pool, Enter submits
- [ ] Render optimistically from the pane row's data, fill stats in when they land
- [ ] No stats → render the page without them, never zeros

### 6 · UI — quote expiry recovery
- [ ] Replace the dead "Expired" state with **Get fresh quote**
- [ ] Calls `/trade/requote`; keep old numbers visible while re-pricing
- [ ] Spinner on the button; no layout collapse

### 7 · UI — live pane
- [ ] `RefreshCw` spinning while a fetch is in flight
- [ ] "updated 12s ago", ticking
- [ ] Poll 30s → 15s
- [ ] Row enter/exit animation when the set changes
- [ ] `prefers-reduced-motion`: no spin, static state change

### 8 · Verify
- [ ] All four entry paths end to end against mainnet via curl
- [ ] Quote through microduck's hooked NVDA pool — the one the old code missed
- [ ] Requote after real expiry; old `quoteId` refused
- [ ] Dexscreener unreachable → page still renders from chain data
- [ ] Unknown/garbage address → clean rejection, not a 500
- [ ] `tsc --noEmit` both apps; `next build`

---

## Risks

- **Third-party dependency.** Dexscreener is now in the discovery path. It is
  rate limited, can be blocked by network policy, and may lag a fresh token.
  The on-chain fallback is not optional — build it in step 1, not after.
- **Quote-time liquidity.** `liquidity.usd` is Dexscreener's snapshot. The
  quoter is still the authority on what a trade actually fills at, and the
  confirm card's guaranteed minimum remains the number that binds.

## Carried over from v1

- `priceImpactBps` is always `0`. **Do not render it.**
- Funding asset comes from pools that exist; a named currency with no pool is
  refused, never substituted.
- `MAX_TRADE_USD` is enforced in real dollars and fails closed when the asset
  cannot be priced.
