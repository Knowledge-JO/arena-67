# Arena 67 — research: token reports, holders, overlap

Turns the agent from "finds a token and trades it" into a research desk you can
question. Two things it cannot do today:

1. **"What do you know about arena67?"** → one full report: market data,
   socials, pools, supply, **holders and how concentrated they are**.
2. **"Top holders of the highest-volume tokens in the last 24h — who holds more
   than one?"** → rank tokens by 24h volume, pull each one's top holders, and
   cross-reference them.

Trading stays as it is. The existing trade flow is the "act on it" half.

Spans backend, MCP server and UI.

---

## What we measured (2026-09-27, mainnet)

| question | answer |
|---|---|
| Does Dexscreener have holder data? | **No.** It has price, mcap, fdv, liquidity, volume (m5/h1/h6/h24), buys/sells, price change, socials, pair age. |
| Can Dexscreener rank by 24h volume? | **Yes.** `/tokens/v1/robinhood/{a,b,…}` takes up to 30 tokens per call and returns `volume.h24`. |
| Blockscout holders API? | **403 from our sandbox** (Cloudflare). Not yet tested from a normal machine — see Decision 1. |
| Holders computed from `Transfer` logs? | **Yes, it works.** VLAD: 536 transfers → 93 holders in 0.6s. |
| What does the RPC limit? | **10,000 logs per query**, not a block range. Chunks can adapt: halve on overflow, double when sparse. |
| How expensive is a busy token? | microduck (30 days old): **137k transfers, 10k holders in the first 3% of its history** (launch-day bots). ~1,600 transfers/sec. A cold rebuild takes **minutes**. |
| How expensive is keeping it current? | Cheap. microduck now: ~364 transfers per 100k blocks (~2.8h). |

**What this means for the design:** holder data cannot be computed when someone
asks. It has to come from an **indexer that runs in the background**,
builds each token's holders once and then keeps them current. A question about a
token we have not indexed yet gets an honest "holders: indexing, 40% done" and
still gets everything else.

---

## The traps (why this is more than "fetch holders")

**1. The PoolManager is the top holder of everything.** Uniswap v4 keeps all
pool liquidity in one contract. Ask "which addresses hold more than one of these
tokens" naively and the answer is `0x8366…0951`, every time, plus the burn
address. So **every holder gets a label** before any analysis:

| label | how we know |
|---|---|
| `pool` | the v4 PoolManager; v2/v3 pair addresses from Dexscreener (`pairAddress`) |
| `burn` | `0x0…0`, `0x…dEaD` |
| `token` | the token contract itself |
| `contract` | has bytecode (lockers, multisigs, routers, unknown) |
| `wallet` | no bytecode, **or** EIP-7702 delegation (`0xef0100…`), which is a wallet with a delegate |

Overlap and concentration default to **`wallet` only**. Labels are cached; code
does not change once deployed (a counterfactual address can gain code later, so
`wallet` labels are rechecked when they are about to be shown).

**2. "Holds 40%" needs a denominator.** Percentages are computed against
`totalSupply()` read from the token, not the sum of balances we indexed. The
report separates **held by pools**, **burned**, and **held by wallets**, so
"top holder 40%" is never secretly the liquidity pool.

**3. Log-derived balances can be wrong.** Rebasing and fee-on-transfer tokens,
or tokens that mint without a `Transfer`, break the arithmetic. Two guards:
- the **top holders shown are re-read with `balanceOf`** (one Multicall3
  call), so what the user sees is exact even if the index drifted;
- if indexed balances and `totalSupply()` disagree by more than 1%, the report
  says so instead of presenting shaky numbers as fact.

**4. The cross-referencing must be a tool, not the model.** Intersecting ten
lists of 50 addresses by reading them is where an LLM makes things up.
`find_common_holders` does it in code and returns the answer. The model decides
*when* to call it and explains the result.

**5. Tool output must stay small.** microduck has 10k holders. Tools return the
top N (default 20, max 100) and summaries, never whole lists.

---

## Decisions

**Decision 1 — where holder data comes from.**
*Default: index it from the chain.* Exact, no third party, works on a chain
this new. The cost is the indexer and a warm-up period per token.

Blockscout may be faster to build and instant for cold tokens, but we cannot
reach it from here. **Check from a normal terminal:**
```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  https://robinhoodchain.blockscout.com/api/v2/tokens/0xd5f1afea47b1a9eab414d2ee740cf1d6d039e725/holders
```
`200` → phase 7 adds it as the **first** source behind the same interface
(`HolderSource`), with the indexer as the fallback. Anything else → indexer
only. Nothing before phase 7 depends on the answer.

**Decision 2 — store balances, not transfers.** The index keeps
`(token, holder) → balance` and a cursor, not every transfer. That answers
"who holds" and "who holds several". It **cannot** answer "who bought in the
last hour" or "what did this wallet hold last week". Those need raw transfers,
roughly 10× the storage. Deferred (see Out of scope). The schema leaves room
to add them.

**Decision 3 — which tokens get indexed.**
- the **top 20 by 24h volume**, refreshed every 5 minutes (warmed at boot);
- **any token a user asks about** (queued on first request);
- tokens **held by our users' wallets**.
Everything else is indexed only on demand. A token that falls out of the
tracked set stops live-tailing after 24h, but its index is kept.

**Decision 4 — volume candidates come from live swaps.** *(Revised while
building.)* The pool index only covers the last ~5.6h of pool **creations**,
so an old token trading heavily today is not in it. Measured instead:
- the v4 PoolManager emits ~1,000 `Swap` events a minute (~1.5M a day), so
  scanning a full day is out (~40 min), but **tailing it is 1–2 queries a
  minute**;
- Dexscreener's `/latest/dex/pairs/robinhood/{poolIds}` takes our poolIds
  (30 per call) and returns each pool's tokens and 24h volume.

So: tail swaps, keep a rolling per-pool swap count, send the most active pools
to Dexscreener, add up volume per token, and rank. A token with no v4 swap
in the observed window is not ranked. The response states the window ("pools
active in the last N minutes"), and the volume figures are Dexscreener's 24h
totals.

**No archive node.** The RPC has no historical state (`eth_getCode` at an
old block fails), so the deploy block cannot be found by binary search. The
indexer starts at block 0 with a window as wide as the chain. An address-filtered
query over empty history is one cheap call, and the window halves until it
fits under 10,000 logs.

---

## Flow

### "What do you know about arena67?"
```
model → search_tokens("arena67")            (existing; card if ambiguous)
      → get_token_report(address)
          ├─ Dexscreener: price, mcap, fdv, liquidity, volume, buys/sells,
          │  price change, pair age, socials, pools (one per quote asset)
          ├─ chain: name, symbol, decimals, totalSupply, owner() if any
          ├─ holders (indexed): count, top 10 with labels + %, top-10 wallet
          │  concentration, % in pools, % burned — or indexing status
          └─ queues the token for indexing if it is not tracked
      → writes the analysis; UI renders a TokenReport card
```

### "Top holders of the high-volume tokens — who holds more than one?"
```
model → get_top_volume_tokens(window: "h24", limit: 10)
      → find_common_holders(tokens: [...10], topN: 50, minTokens: 2)
          ├─ top 50 *wallets* per token (pools/burns/contracts excluded)
          ├─ intersect in code
          └─ { overlaps: [{ address, tokens: [{symbol, pct, rank}] }],
               coverage: { indexed: 8, indexing: [..2 with % done] } }
      → explains what it found; UI renders a HolderOverlap card
```
Two tool rounds plus the answer, well inside the 5-round limit. No composite
"do everything" tool is needed, and the model still chooses the path.

### "Tell me about 0xabc…" (a wallet)
```
model → get_wallet_holdings(address)   → tokens held among indexed tokens,
                                          with % of supply and USD value
```
It comes almost free with the index and makes overlap results explorable: click
an address in the overlap card and ask about it.

---

## Phases

### 1. Holder index — schema and core
- [x] Migration `0002_holders.sql`:
  - `token_holders (token, holder, balance numeric(78,0), updated_block)`,
    PK `(token, holder)`, index `(token, balance DESC)`
  - `token_index_state (token PK, status, from_block, cursor_block, head_block,
    transfers_seen, holder_count, total_supply, last_error, tracked_until,
    requested_at, updated_at)`
  - `address_labels (address PK, label, source, checked_at)`
- [x] `HolderIndexService.backfill(token)`: adaptive chunking (start 2M blocks,
      halve on "exceeds limit of 10000", double when a chunk returns under 4k),
      folds each chunk into a balance delta map, **upserts the delta and advances
      the cursor in one transaction**, so a crash resumes instead of
      double-counting
- [x] Start block: ~~first `Initialize` block, or binary search~~ — no archive
      node, so the walk starts at block 0 with one window over all history
- [x] Zero balances deleted, not stored
- [x] Live tail: every tracked, ready token advanced to `head − 20` blocks each
      minute, in **one** multi-address `getLogs` per chunk (as the holdings
      scanner does)
- [x] One backfill at a time (a queue with priority: user-requested > top
      volume > held by users), so a cold boot does not flood the RPC
- [x] Unit tests: delta folding, mint/burn, cursor resume after a mid-chunk
      crash, adaptive chunk halving

### 2. Labels and supply
- [x] `AddressLabelService.label(addresses[])`: known set (PoolManager, burns,
      the token itself, Dexscreener pair addresses) then `getCode` in batches;
      `0xef0100…` → `wallet`
- [x] `totalSupply`, `decimals`, `owner()` (best effort) via Multicall3
- [x] `topHolders(token, n, { labels })`: indexed top N, re-read with
      `balanceOf` via Multicall3, % of totalSupply
- [x] Drift check: indexed sum vs `totalSupply()`, flagged over 1%
- [ ] Tests: labelling, the 7702 case, drift flag

### 3. Volume ranking
- [x] ~~Pool-index candidates~~ → `VolumeService`: tails v4 `Swap` events,
      300 busiest pools → Dexscreener pairs → per-token volume (Decision 4)
- [x] Feeds the tracked set (Decision 3)
- [x] Check the call budget against Dexscreener's rate limit (300/min on these
      endpoints)

### 4. Report and analysis endpoints (backend)
All service-authed like the rest; public data needs no user.
- [x] `GET /research/tokens/:address/report` → `{ kind: 'token_report', … }`,
      queues indexing if needed
- [x] `GET /research/tokens/:address/holders?limit&labels`
- [x] `GET /research/top-volume?window=h24&limit=10`
- [x] `POST /research/common-holders { tokens[], topN, minTokens, labels }` →
      `{ kind: 'holder_overlap', … }` (cap: 20 tokens, topN ≤ 100)
- [x] `GET /research/wallets/:address/holdings`
- [x] Every response carries `asOf` and, per token, `holders.status`
      (`ready` | `indexing {pct}` | `queued` | `failed {reason}`)

### 5. MCP tools
- [x] `get_token_report(address)`: description tells the model to use it for
      "what do you know about X", after `search_tokens` if it only has a name
- [x] `get_top_holders(address, limit?, include?)`
- [x] `get_top_volume_tokens(window?, limit?)`
- [x] `find_common_holders(tokens[], topN?, minTokens?)`: says pools, burns
      and contracts are excluded unless asked
- [x] `get_wallet_holdings(address)`
- [x] `get_token` stays for the light lookup; its description points to
      `get_token_report` for the full picture
- [x] Descriptions state what is *not* known (indexing, v2/v3-only tokens), so the
      model does not fill gaps by guessing

### 6. Agent and UI
- [x] `token_report` and `holder_overlap` added to `RENDERABLE_STEPS`; the
      stored step is trimmed (top 10 / top 25 overlaps) before it is saved
- [x] System prompt: research guidance. Report, then interpret. Say plainly when
      holders are still indexing. Never present pool or burn balances as a
      whale.
- [x] `TokenReportCard`: header (logo, name, price, 24h change), market grid
      (mcap, fdv, liquidity, volume, buys/sells, age), socials, holders block
      (count, top 10 with label chips and % bars, concentration, pools/burned
      split, or an indexing progress line), and a **Trade** button that enters
      the existing token-detail flow
- [x] `HolderOverlapCard`: tokens compared (chips), coverage note, table of
      addresses → tokens held with %; an address click sends "What does 0x… hold?"
- [x] Both render from stored steps, so they survive a reload like the
      portfolio card
- [x] Mobile: cards collapse to stacked rows, no horizontal scroll

### 7. Blockscout source (only if Decision 1 returns 200)
- [ ] `HolderSource` interface; `BlockscoutHolderSource` (holders, holder
      count, token counters), `IndexedHolderSource` (the above)
- [ ] Report uses Blockscout when it answers, the index otherwise, and says
      which (`source` field)
- [ ] Overlap stays on the index unless Blockscout paging can serve top 50 per
      token within the rate limit

### 8. Verification
- [x] Backfill VLAD (small) and microduck (busy) to `ready`; holder count and
      top 10 checked against `balanceOf`
- [ ] Drift check passes on both; a deliberately corrupted row trips it
- [x] Live: "what do you know about microduck" → report card with holders
- [x] Live: "top holders of the 10 highest-volume tokens, who holds more than
      one" → overlap card; PoolManager **absent** from the result
- [x] Live: ask about a never-indexed token → report arrives now, holders say
      "indexing", ready on a later ask
- [ ] Restart mid-backfill → resumes from the cursor, final balances identical
- [x] Tests pass, all three apps typecheck

---

## Out of scope (for now)

- **Flow questions** ("who bought in the last hour", "fresh wallets", "sniper
  detection"): need raw transfers (Decision 2). The natural next phase: add a
  `token_transfers` table over the same backfill.
- **Wallet clustering** (addresses funded from a common source): needs ETH
  transfer history, a different index.
- **Contract risk checks** beyond `owner()` (mint functions, blacklist, tax):
  needs bytecode or source analysis; Blockscout's verified source would help.
- **Historical holder snapshots.**
- **v2/v3-only tokens** in the volume ranking (Decision 4).

---

## Risks

| risk | mitigation |
|---|---|
| Cold boot indexes 20 busy tokens → tens of minutes, heavy RPC load | one backfill at a time, prioritised; progress is visible; the report never waits on it |
| Public RPC rate-limits or goes down | backoff and resume from the cursor; `failed` status with the reason; `RPC_URL` can point to a paid endpoint |
| PGlite size with ~10k rows × 20+ tokens | fine (hundreds of thousands of small rows); production uses `DATABASE_URL` |
| Model narrates overlap it did not compute | overlap only exists as tool output; the prompt says so; the card shows the computed data |
| Labels wrong (e.g. a locker marked `contract` is really team supply) | labels are shown, not hidden: the user sees "contract" and can ask; the overlap filter can be widened |

---

## Build notes (2026-09-27)

Built phases 1–6 and verified live on mainnet; phase 7 (Blockscout) not started.

**Verified live**
- Indexer: 18k-transfer tokens index in ~35s, small ones in ~3s; one queue slot
  is kept for user requests so nobody waits behind prefetching.
- Holder labels and drift check correct on real tokens (v4 PoolManager and a
  v2/v3 pair both labelled as pools; indexed sums matched totalSupply).
- "What do you know about microduck?" → search → report card, ~16s.
- "Which wallets hold more than one of the top 10 tokens by volume today?" →
  `get_top_volume_tokens` → `find_common_holders` → overlap card, ~23s; found
  a wallet that is #1 holder of CASHED and #2 of MEME; PoolManager absent.
- Wallet holdings and Buy follow-ups from the cards work through the agent.
- UI screenshotted at 1440px and 390px (report, top tokens, overlap, wallet).

**Found and fixed while building**
- `eth_getCode` batches over 10 entries get 429 from this RPC, which silently
  labelled every holder "contract" and emptied the overlap. Replaced with a
  45-byte deployless probe: 300 addresses in one `eth_call` (~350ms).
- Token search only knew pools from the last ~5.6h, so month-old tokens could
  not be found by name. Now merged with Dexscreener's text search.
- Condensed search results hid addresses from the model, which then invented
  one. Addresses are now included.
- A search-choices card no longer replaces a report card from the same turn.
- An unhandled Postgres socket error crashed the whole server on a network
  blip. Pool and client errors are now logged instead.
- The agent's failure message blamed the MCP server for every error and
  quoted a port. Now plain, and names the right cause. *(Typechecked; not
  re-run live — the network dropped before it could be.)*

**Still open**
- Unit tests for labelling and the 7702 case; a live mid-backfill restart test.
- Phase 7 (Blockscout) — needs the `curl` check from Decision 1.

## Live check on Neon (2026-09-27, afternoon)

Database confirmed live; all research flows re-run against it and saved there.
An unstable network during the check exposed five ways the backend could die
or stall, all fixed:

- **Startup gave up on one failed read.** Database migrations and the chain
  id check now retry with backoff (2s → 32s). A wrong chain still refuses to
  boot immediately; only unreachability is retried.
- **Block-number reads at startup** (chain banner, pool index, holdings
  scanner) could stop the boot. They now log and retry in the background.
- **A backfill failure could crash the server** when the database was the
  thing that failed, because recording the failure also needed it. That path
  can no longer throw, and a `unhandledRejection` handler in `main.ts` logs any
  stray background rejection instead of exiting.
- **Rows left "indexing" by an unrecorded failure** are picked up again by the
  queue instead of waiting for a restart.
- **Catch-ups waited behind huge first-time backfills** (AI: 1.1M transfers).
  A quick lane now runs tokens already within ~8h of the head: after five
  hours down, busy tokens caught up in 4–9s while a 1.3M-transfer backfill kept
  running. A failed head read skips the quick lane for one pass instead of
  stalling the queue.

Also: with fewer than two tokens counted, the agent now says no comparison
was possible yet, instead of "no overlaps found".
