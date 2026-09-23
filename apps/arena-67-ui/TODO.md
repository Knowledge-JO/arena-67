# Arena 67 — UI build

Minimal trading + research arena for Robinhood Chain memecoins.
Chat drives the trade; the side panel shows what's moving.

**Deadline: Sept 28, 00:00 UTC.** Anything marked `[stretch]` gets cut first.

---

## Design intent

One screen, two panes, no dashboard sprawl.

- **No buy/sell buttons scattered around.** The chat *is* the interface. The
  only clickable affordances are the ones the agent puts in front of you:
  a token to pick, a quote to confirm.
- **Every trade step is a card in the conversation**, not a modal. The
  transcript is the audit trail — you can scroll back and see exactly what you
  agreed to and what it cost.
- **Motion carries meaning, never decoration.** Cards enter to show a new step
  arrived; the confirm card's countdown ring shows a quote going stale. If an
  animation doesn't tell you something, cut it.
- **Dark-first.** This is a trading surface people stare at for hours.

---

## Stack decisions

| Choice | Why |
| --- | --- |
| `motion` | Layout + presence animation. React 19 ready. |
| `lenis` | Smooth scroll on the research pane. |
| ~~shadcn/ui~~ | **Skipped** — its value is Radix primitives for dialogs, selects, popovers. This surface has none; the components needed were a button and a card. Add it the moment a real overlay is needed. |
| ~~`react-spring`~~ | **Skipped** — overlaps `motion` entirely. Two animation runtimes is a bundle cost and two mental models for no gain. Revisit only if we need physics `motion` can't do. |

---

## Backend contract (already built)

Base URL `http://localhost:9000` (override with `NEXT_PUBLIC_API_URL`).

```
GET  /trade/wallet          -> { address }
POST /trade/begin           { sessionId, intent }              -> TradeStep
POST /trade/select-token    { sessionId, intentId, candidateId } -> TradeStep
POST /trade/amount          { sessionId, intentId, amount }    -> TradeStep
POST /trade/confirm         { sessionId, intentId, quoteId }   -> TradeStep
GET  /research/trending     -> { index, tokens[], lastRefresh, stale, error }
```

`TradeStep.kind` is one of:
`need_token` · `choose_token` · `need_amount` · `confirm` · `executed` · `rejected`

**The client never sends a contract address or a raw amount back as free text.**
It echoes `candidateId` / `quoteId`. The server re-reads the real values from
its own store — that's what stops a tampered payload becoming a signed swap.
Don't "simplify" this away.

---

## Tasks

### 1. Foundation
- [x] Install `motion`, `lenis`, shadcn deps (`clsx`, `tailwind-merge`, `cva`, `lucide-react`)
- [x] `lib/utils.ts` — `cn()` helper
- [x] Theme tokens in `globals.css`: surface / border / muted / accent / positive / negative, dark-first
- [x] Replace boilerplate `layout.tsx` metadata + the `create-next-app` `page.tsx`
- [x] `lib/session.ts` — stable per-browser `sessionId` (localStorage, wrapped in try/catch)
- [x] `lib/api.ts` — typed fetch wrapper mirroring `TradeStep`

### 2. Shell
- [x] Two-pane layout: chat centre, research right. Single column under `lg`.
- [x] Header: wordmark, agent wallet address (truncated, click-to-copy), chain badge
- [x] Empty state — the one place we *tell* people what to type

### 3. Chat
- [x] Message list, auto-scroll to newest, `prefers-reduced-motion` respected
- [x] Composer: textarea, Enter sends / Shift+Enter newline, disabled while in flight
- [x] Agent "thinking" indicator
- [x] Render each `TradeStep` kind as its own card (below)

### 4. Trade step cards
- [x] `need_token` / `need_amount` — plain prompt bubble
- [x] `choose_token` — **the disambiguation card.** Symbol, name, full address
      (monospace, copyable), pool count, warning chips. Selecting sends
      `candidateId`. This is the core interaction; make it feel good.
- [x] `confirm` — spend / receive / guaranteed minimum / pool fee. Countdown
      ring on the 30s quote TTL. Confirm sends `quoteId`.
- [x] `executed` — fill summary + explorer link
- [x] `rejected` — reason, recoverable, never a dead end

### 5. Research pane
- [x] Trending list from `/research/trending`, poll ~30s
- [x] Row: symbol, name, pool count. Click → seeds the composer with that token
- [x] Lenis smooth scroll
- [x] Stale badge when `stale: true`; keep showing last good data
- [x] Index-warming state (`index.ready === false`)

### 6. Polish
- [x] Loading skeletons (no layout shift)
- [x] Error + offline states for a backend that isn't running
- [x] Mobile: 16px gutters, no horizontal scroll
- [x] Keyboard: focus rings, `/` focuses composer, Esc cancels
- [x] `prefers-reduced-motion` honoured throughout

### 7. Stretch
- [ ] `[stretch]` WebSocket streaming for live trade status
- [ ] `[stretch]` Sparklines per trending token
- [ ] `[stretch]` Portfolio / agent holdings view

---

## Known gaps (backend, not UI)

- Agent wallet bridge is **unverified** — Coinbase API was unreachable from the
  dev sandbox. `npx nest start` locally should log `Agent wallet 0x…`.
- Trending ranks by *pool count*, not volume. Label it honestly in the UI —
  "pools", not "24h volume". Don't display a number the backend isn't measuring.
- `priceImpactBps` is always `0` (needs StateView spot). **Don't render a price
  impact figure until it's real.** Show guaranteed minimum instead — that one
  is true.

---

## Verified (2026-09-23)

- `npx tsc --noEmit` — clean
- `npx next build` — compiled in 56s, static `/` generated, rc=0
- Served on :3100 → HTTP 200. Header, empty state, example chips, trending pane
  and the "nothing is signed" note all present in the served HTML.
- Tailwind 4 `@theme inline` tokens **do** compile: `bg-surface-raised`,
  `text-fg-muted`, `border-border-base`, `bg-bg`, `h-dvh` all emitted.
  Opacity modifiers (`bg-accent/15`) compile to `color-mix(in oklab, …)`
  preceded by a solid-colour fallback, so older browsers degrade not break.
- Custom `prefers-reduced-motion` and `.lenis` rules survive the build.

**Still unexercised: every interactive path.** Cards, Lenis scrolling and the
polling are verified only as "compiles and renders". No trade has been driven
through the UI, because the backend cannot start past `WalletService` without
the Coinbase API, which is blocked from the dev sandbox. First local run should
target: pick a token → set amount → see a quote → confirm.
