# Arena 67 — sandbox (paper trading on mainnet prices)

A switch between **Sandbox** (paper money) and **Live** (the user's real
wallet). Research is identical in both. In sandbox, trades are quoted and
filled at real Robinhood Chain prices but nothing is signed: balances, trades
and profit live in a paper ledger.

**Default mode: Sandbox**, for new and existing users.

---

## Decisions

1. **Fills are real prices.** Confirm re-quotes on the same pool with the same
   on-chain quoter (fees, hooks, price impact). The paper fill is that fresh
   quote. If it has fallen below the minimum the user agreed to, the trade is
   rejected — exactly as the swap would revert on-chain.
2. **A simulated network fee** (~180k gas × current gas price) is charged in
   paper ETH; if there is not enough ETH, its dollar value comes out of the
   funding asset instead, and the card says so (mainnet would need real ETH).
3. **Separate ledger.** `paper_accounts`, `paper_balances`, `paper_trades`,
   `paper_deposits`. Nothing paper is written to `trades`, and no paper path
   touches the signer.
4. **Mode is server-side and baked into each trade.** `users.trading_mode`.
   Every pending trade records the mode it started in; confirming a trade
   whose mode differs from the user's current mode is refused. A sandbox trade
   can never reach the signer.
5. **Deposits are not profit.** Top-ups are recorded with their dollar value.
   Profit = realised (on sells, against average cost) + unrealised (holdings at
   live price minus their cost). Total return = equity − net deposits.
6. **ETH and WETH share one paper balance.** On mainnet they are different
   assets that need wrapping; in the sandbox both pool types just work.
7. **Funding** in ETH or USDG, any amount up to $1M per top-up. **Reset**
   starts a fresh epoch (old trades kept, not shown).
8. **No per-trade USD cap in sandbox** (the cap protects real money). Price
   impact still applies because the quoter is real.
9. **The model cannot change the mode.** Switching is a UI action by the user;
   switching to Live asks for confirmation. The agent may add paper funds.

## Differences from mainnet (said in the UI where it matters)
- No other traders react to your order; your fill does not move the pool.
  *(Portfolio card footer.)*
- ~~Tokens with a transfer tax look better on paper.~~ **Closed:** the tax is
  now measured on-chain and applied to paper fills, and shown on the confirm
  card and in the token report — for live trades too.
- ETH/WETH are interchangeable; gas can be paid from USDG. *(Confirm card
  note for WETH pools; fee line and filled card say which balance paid.)*

---

## Build

### Backend
- [x] Migration: `users.trading_mode` (default `sandbox`), `paper_*` tables
- [x] `SandboxService`: account/epoch, balances, deposit (valued in USD),
      reset, fill (debit/credit, fee, cost basis, realised PnL), summary and
      portfolio (live prices, unrealised PnL, total return)
- [x] Mode: `GET/PUT /account/mode`; `/auth/me` returns it
- [x] Trading: intent carries `mode`; balance check and spend cap by mode;
      confirm in sandbox = fresh quote → minimum check → paper fill;
      mode mismatch refused; confirm/executed steps carry `mode`
- [x] `/wallet/portfolio` and `/wallet/trades` answer for the current mode
- [x] `GET /sandbox`, `POST /sandbox/deposit`, `POST /sandbox/reset`
- [x] Tests: fill maths, cost basis and realised PnL, deposit ≠ profit,
      minimum-out rejection, mode mismatch refusal, ETH/WETH sharing, fee
      fallback

### Agent / MCP
- [x] System prompt states the mode each turn
- [x] `add_paper_funds` tool (sandbox only); no tool to change mode
- [x] Portfolio / history descriptions mention the mode

### UI
- [x] Header switch Sandbox | Live; Live asks for confirmation
- [x] Amber sandbox strip with "Add funds"
- [x] Wallet box: paper value in sandbox
- [x] Add funds dialog (ETH/USDG, presets, reset)
- [x] Confirm card: "Paper trade", "Place paper trade"; fee line
- [x] Executed card: "Paper trade filled" (no explorer link)
- [x] Portfolio card: sandbox badge, net deposits, total return, per-holding
      profit
- [x] Empty sandbox: clear prompt to add funds

### Verify
- [x] Deposit → buy → price moves → sell: balances and profit add up
- [x] Switching mode mid-trade refuses the old quote
- [x] Live path unchanged (tests)
- [x] Screenshots desktop + phone

---

## Second pass (2026-09-27)

The first pass ticked every box at once; an audit found four gaps. Closed:

- [x] **Confirm card fee line** — it was only on the filled card. Paper quotes
      now show "under $0.01 (about $0.0097), paid in paper ETH (simulated)",
      or that it comes from USDG, using the same rule as the fill.
- [x] **Transfer tax** — measured, not assumed. A 1.3 KB probe runs in one
      `eth_call` via state override at the v4 PoolManager address: sends
      tokens out as a buy would, back as a sell would, measures both. Checked
      against a synthetic 5% token (5.00% / 5.00%) and 32 live tokens (all 0%;
      the ones that first failed were network blips, all measured on retry).
      Applied to paper fills after the pool minimum check, shown on confirm
      cards (live too), and a "Things to know" line in token reports. Unknown
      is shown as "could not be checked", never as "no tax".
- [x] **ETH/WETH note** on the confirm card for WETH pools in sandbox.
- [x] **Verified live** what had not been: $1M cap and invalid amounts
      refused; reset clears holdings, deposits and visible history; a paper
      buy paid in ETH takes trade + fee from the same balance; "sell half of
      my AI" and "what paper trades have I made" through the agent.

Found along the way:
- **"Pool fee 838.8608%"** on dynamic-fee pools — the v4 dynamic flag
  (0x800000) was divided as if it were a fee, on live trades as well. Stored
  fee reads 0 for those pools (the hook sets it per trade), so the card now
  says it is set per trade and already in the price.
- A failed tax measurement was cached as "unknown" for 10 minutes; now 30s.

**Tests:** 92 across 9 files (tax maths, tax applied to quote and fill,
unknown-tax wording, dynamic fee text, report tax signal).

## Build notes — first pass (2026-09-27)

Built and checked live against mainnet prices, on an isolated backend.

**Verified**
- New account starts in Sandbox. 1,000 USDG + 0.05 ETH deposited ($134.53 at
  the live ETH price).
- Paper buy of 100 USDG of AI: re-quoted at confirm (471.700 vs 471.691 shown),
  fee $0.0098 in paper ETH, no transaction hash, signer never touched.
- Paper sell of 200 AI: realised −$0.23 (the round-trip pool fee and spread).
  Realised + unrealised = total return to six decimals after every step.
- A sandbox quote confirmed after switching to Live was refused.
- Asked to "switch me to live", the agent explained it can't and pointed at the
  switch; the mode stayed Sandbox. `add_paper_funds` from chat worked.
- Full trade through the UI at phone size: paper confirm card → Place paper
  trade → filled card; header balance updated. Go-Live dialog focuses the safe
  choice. No horizontal overflow at 390px or 360px.

**Found and fixed along the way**
- A network blip made "is this a token?" answer "no" for a real $220M token.
  Transport failures are now reported as "could not reach the chain".
- Confirm-card amounts showed 12+ decimals; now 8 significant digits, cut
  rather than rounded so a guaranteed minimum is never overstated.
- Balances showed as "$1.6K" next to a −$0.36 return; money the user is
  tracking now shows exact dollars ($1,634.16) and non-zero percentages.
- The header overflowed a phone screen by 1px (≈30px on 360px phones).

**Tests:** 84 backend (27 new: paper ledger accounting, sandbox confirm path,
mode-switch refusal — mutation-checked — fee fallback, amount formatting,
transport-error detection).

**Note for existing data:** migration 0003 puts every existing user in Sandbox
(the default you chose). Anyone who was trading live switches back with the
header toggle.
