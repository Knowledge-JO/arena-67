import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { McpClientService, type McpSession } from './mcp-client.service';
import { ConversationService } from '../memory/conversation.service';
import { AuthService } from '../auth/auth.service';
import { SandboxService, type TradingMode } from '../sandbox/sandbox.service';
import { historyForModel, type StoredTurn } from './history';
import {
  ReasoningService,
  type ChatMessage,
  type ToolCall,
} from './reasoning.service';

export interface ToolCallEvent {
  id: string;
  name: string;
  input: Record<string, unknown>;
  status: 'started' | 'completed' | 'failed';
  error?: string;
}

export type ToolCallListener = (event: ToolCallEvent) => void;

/**
 * Trade steps the UI knows how to draw. Detected by the *shape* of a tool
 * result rather than by which tool produced it — a new tool that emits a step
 * is rendered without the agent learning its name.
 */
const RENDERABLE_STEPS = new Set([
  'portfolio',
  'token_choices',
  'need_token',
  'choose_token',
  'token_detail',
  'confirm',
  'executed',
  'rejected',
  'token_report',
  'top_tokens',
  'holder_overlap',
  'wallet_holdings',
]);

/**
 * One card per turn, so when several tools produced one, which to show.
 * The latest, except that a list of search candidates never replaces a card
 * with substance — a turn that searched, then reported, should end on the
 * report, not on "which one did you mean".
 */
function pickStep(
  current: Record<string, unknown> | null,
  next: Record<string, unknown>,
): Record<string, unknown> {
  if (current && next.kind === 'token_choices' && current.kind !== 'token_choices') return current;
  return next;
}

/** Stored steps are capped: a conversation reloads every card it ever drew. */
const MAX_STORED_OVERLAPS = 50;

export interface AgentTurn {
  reply: string;
  /** Named in call order, so the UI can show what the desk actually did. */
  toolsUsed: string[];
  /** True when the loop hit its ceiling before the model was finished. */
  truncated: boolean;
  rounds: number;
  /**
   * The last renderable trade step a tool produced this turn, if any.
   *
   * The agent narrates; the card carries the numbers. Prose alone would mean
   * quoting a price in a sentence the user has to trust, when the confirm card
   * already shows the guaranteed minimum and the button that signs it.
   */
  step: Record<string, unknown> | null;
  messages: ChatMessage[];
}

const SYSTEM_PROMPT = `You are Arena 67, a memecoin research and trading desk on Robinhood Chain.

You answer two kinds of question: what is this token, and how do I trade it.

Rules:
- Use tools for anything factual. Never state a price, market cap, volume or
  contract address from memory — if a tool did not return it, say you do not know.
- Several tokens routinely share a ticker. When a search returns more than one,
  show the candidates with their addresses and pool counts and ask which they
  mean. Never pick for them.
- When a tool reports a token has no market data, say exactly that. Do not
  describe it as worth zero.
- Quote the guaranteed minimum from a quote, not the expected fill: that is the
  number the swap enforces on-chain.
- You cannot sign. Trades are confirmed by the user in the app. Never claim a
  trade executed.
- Percentages, "all", "max", "half" are sizes, not missing information. Pass
  them as \`percent\` (100 for all, 50 for half) to prepare_trade or
  get_quote — never ask for a token count instead, and never convert a
  percentage into an amount yourself: the backend uses the exact balance.
  For a sell the percentage is of the token held; for a buy, of the asset
  being spent (e.g. "buy with half my USDG").
- Be brief. Traders are reading fast. Lead with the answer.
- Never write tables. The chat cannot draw them, and every table you would
  write is already a card on the user's screen.

The desk draws cards for you. When a tool result has a "kind" field, the user
is already seeing it as a card with the addresses, prices and market caps laid
out and clickable. Do not repeat that content as a list — restating a card in
prose doubles the screen and makes the clickable version look like decoration.
Say in one or two lines how the options differ and ask which they want.

Research:
- "What do you know about X" / "tell me about X" / "is X safe" → get_token_report
  (search_tokens first if you only have a name). If the search has exactly one
  match, or one match is plainly the real token (far larger market cap than
  the rest), go straight to its report — do not stop to ask. Search once. The user sees the report as a
  card. Give a short read of it: what stands out, the signals that matter, and
  anything missing. Do not restate every figure.
- Holder percentages are shares of total supply. A liquidity pool or burn
  address is not a person — never call one a whale or a holder "owning" the
  token.
- "What's trading the most" → get_top_volume_tokens.
- "Who holds several of these" / "common holders" / "wallets in more than one"
  → find_common_holders with the token addresses (for "the top volume tokens",
  get_top_volume_tokens first). Only report overlaps the tool returned. If some
  tokens were still being counted, say which and that asking again in a few
  minutes will include them.
- "What does 0x… hold" → get_wallet_holdings (get_portfolio for the user's own).
- When holder data is still being counted, say so plainly and that the card
  will fill the holders in by itself when counting finishes — nobody needs to
  ask again. Never fill the gap yourself.
- Signals are facts, not advice. Do not tell anyone to buy or sell.

The user is signed in and has their own wallet. Tools that read their account
(get_portfolio, get_trade_history, recall_memory) act for them automatically —
you never need or supply a user id.

Two kinds of memory, and they are not interchangeable:
- "what did I buy / sell" → get_trade_history. It is exact.
- "what do I hold" / "show my portfolio" / balance / profit → get_portfolio,
  EVERY time — even if you showed it a moment ago. Balances and prices change
  constantly; earlier messages are out of date. Never answer these from the
  conversation, and never say "no change since last check".
- "that token we discussed" / "what did I say about X" → recall_memory. It is
  approximate recollection of past conversations; present it that way.
Never answer a holdings or trade question from recalled conversation.`;

/** What the model must know about the mode, stated fresh every turn. */
function modeNote(mode: TradingMode): string {
  return mode === 'sandbox'
    ? `MODE: SANDBOX. The user is paper trading. Trades fill at real mainnet
prices but spend paper funds — nothing real moves. Call their balances and
trades "paper" or "sandbox". If they have no paper funds, offer to add some
(add_paper_funds). You cannot switch modes: if they want to trade real money,
tell them to use the Sandbox/Live switch at the top of the app.`
    : `MODE: LIVE. Trades spend real funds from the user's own wallet. Be
explicit that a trade uses real money. You cannot switch modes: if they want to
practise, tell them to use the Sandbox/Live switch at the top of the app.`;
}

@Injectable()
export class AgentService {
  private readonly log = new Logger(AgentService.name);

  constructor(
    private readonly reasoning: ReasoningService,
    private readonly mcp: McpClientService,
    private readonly config: ConfigService,
    private readonly conversations: ConversationService,
    private readonly auth: AuthService,
    private readonly sandbox: SandboxService,
  ) {}

  /**
   * One conversational turn, with tools.
   *
   * The loop is the whole agent: ask the model, run whatever tools it asked
   * for, hand back the results, ask again. It ends when the model answers
   * instead of calling a tool.
   *
   * The turn ceiling exists because a model that misreads a tool result can
   * call it forever, and each pass costs tokens and upstream requests. Hitting
   * it is reported rather than hidden — a truncated answer that looks complete
   * is worse than one that admits it stopped early.
   */
  async chat(
    userId: string,
    conversationId: string,
    userMessage: string,
    signal?: AbortSignal,
    onToolCall?: ToolCallListener,
  ): Promise<AgentTurn> {
    // History comes from the database, not the client. The client used to post
    // its own transcript back each turn, which meant it could rewrite what the
    // model believed had already been said.
    const history = await this.conversations.recent(userId, conversationId);

    // Saved before the model runs, so a turn that fails part-way still leaves
    // the user's words in the conversation rather than silently dropping them.
    await this.conversations.append(userId, conversationId, {
      role: 'user',
      content: userMessage,
    });

    const token = await this.auth.mintMcpToken(userId);
    // Read per turn: the switch can flip between messages.
    const mode = await this.sandbox.mode(userId).catch(() => 'sandbox' as const);

    let turn: AgentTurn;
    try {
      turn = await this.mcp.withUserSession(token, (session) =>
        this.loop(session, conversationId, history, userMessage, mode, signal, onToolCall),
      );
    } catch (err) {
      // Fail closed. A model handed no tools does not say it cannot help — in
      // testing it wrote imitation tool-call syntax naming tools that never
      // existed, which a user cannot tell apart from a real answer.
      const message = (err as Error).message ?? '';
      this.log.error(`agent turn failed: ${message}`);
      // Said in plain words, and about the right thing: this used to blame
      // the research tools for every failure, including the model itself
      // being unreachable, and quoted a port number at people who trade.
      const modelDown = /^SERV\b/.test(message);
      // Out of credits is not an outage: retrying will not help, and whoever
      // runs the app needs to know to top up. Said plainly, and logged loudly.
      const outOfCredits = /^SERV 402\b/.test(message);
      if (outOfCredits) {
        this.log.error('OpenServ account is out of credits — every chat turn will fail until it is topped up.');
      }
      turn = {
        reply: outOfCredits
          ? 'I’m unavailable right now — the AI service this app uses has run out of credits. ' +
            'Your wallet button at the top still shows your portfolio; chat will be back once the account is topped up.'
          : modelDown
            ? 'I can’t reach my AI service right now, so I won’t guess. Please try again in a moment.'
            : 'I can’t reach my research tools right now, so I won’t guess. Please try again in a moment.',
        toolsUsed: [],
        truncated: false,
        rounds: 0,
        step: null,
        messages: [],
      };
    }

    await this.conversations.append(userId, conversationId, {
      role: 'assistant',
      content: turn.reply,
      step: turn.step,
      toolsUsed: turn.toolsUsed,
    });

    return turn;
  }

  /** The tool loop proper, run inside one user's MCP session. */
  private async loop(
    session: McpSession,
    conversationId: string,
    history: StoredTurn[],
    userMessage: string,
    mode: TradingMode,
    signal?: AbortSignal,
    onToolCall?: ToolCallListener,
  ): Promise<AgentTurn> {
    const maxTurns = this.config.getOrThrow<number>('AGENT_MAX_TURNS');
    const tools = session.tools;

    if (tools.length === 0) {
      throw new Error('MCP session advertised no tools.');
    }

    const messages: ChatMessage[] = [
      {
        role: 'system',
        // The conversation id lets recall_memory exclude the current thread.
        // Passing a different one leaks nothing: recall is filtered by the
        // token's user in the query itself, so the id only ever narrows.
        content: `${SYSTEM_PROMPT}\n\n${modeNote(mode)}\n\nCurrent conversation id: ${conversationId}`,
      },
      // Cleaned: no tables to copy or reuse, and card turns marked stale.
      ...historyForModel(history).map((m) => ({ role: m.role, content: m.content }) as ChatMessage),
      { role: 'user', content: userMessage },
    ];

    const toolsUsed: string[] = [];
    let rounds = 0;
    let step: Record<string, unknown> | null = null;

    for (let turn = 0; turn < maxTurns; turn++) {
      rounds = turn + 1;
      const completion = await this.reasoning.complete(messages, tools, signal);
      messages.push(completion.message);

      const calls = completion.message.tool_calls ?? [];
      if (calls.length === 0) {
        return {
          reply: completion.message.content ?? '',
          toolsUsed,
          truncated: false,
          rounds,
          step,
          messages,
        };
      }

      // Tools in one turn are independent of each other, so they run together
      // rather than serially — three lookups should cost one round trip.
      const results = await Promise.all(
        calls.map(async (call) => {
          toolsUsed.push(call.function.name);
          return { call, text: await this.runTool(session, call, onToolCall) };
        }),
      );

      for (const { call, text } of results) {
        const found = this.asStep(text);
        if (found) step = pickStep(step, this.forStorage(found));
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          name: call.function.name,
          // The card gets the full payload; the model gets a summary. Telling
          // it not to relist candidates did not work — with the rows in its
          // context it formats them into a table every time, which doubles the
          // screen and makes the clickable card look decorative. Withholding
          // the rows is the only reliable version of that instruction, and it
          // costs fewer tokens besides.
          content: found ? this.condense(found, text) : text,
        });
      }

      this.log.debug(
        `turn ${turn + 1}/${maxTurns}: ${calls.map((c) => c.function.name).join(', ')}`,
      );
    }

    // Out of turns with the model still working. Ask it to answer from what it
    // already has rather than returning nothing.
    const last = await this.reasoning.complete(
      [...messages, {
        role: 'user',
        content:
          'Stop calling tools and answer now with what you already have. ' +
          'Say plainly if it is incomplete.',
      }],
      [],
      signal,
    );

    return {
      reply: last.message.content ?? '',
      toolsUsed,
      truncated: true,
      rounds,
      step,
      messages,
    };
  }

  /**
   * What the model sees in place of a step it does not need to recite.
   *
   * Research cards (choices, reports, rankings, overlaps) are condensed: the
   * model gets what it needs to reason and the addresses it may pass on, not
   * rows to recite. Trade steps pass through whole — a quote's numbers and a
   * rejection's reason are things the model has to narrate exactly.
   */
  private condense(step: Record<string, unknown>, original: string): string {
    const shown =
      'The user is already looking at this as a card. Do NOT restate it as a ' +
      'list or table.';

    if (step.kind === 'token_report') {
      const r = step as {
        token: Record<string, unknown>;
        market: Record<string, unknown> | null;
        pools?: Array<{ quoteSymbol: string; liquidityUsd: number }>;
        holders: {
          status: string;
          progress: number;
          holderCount: number | null;
          breakdown: unknown;
          drift: unknown;
          top: Array<{ address: string; label: string; percent: number | null }>;
        };
        signals: unknown;
      };
      return JSON.stringify({
        token: { ...r.token, imageUrl: undefined },
        market: r.market,
        tradesAgainst: (r.pools ?? []).map((p) => `${p.quoteSymbol} ($${Math.round(p.liquidityUsd)} liquidity)`),
        holders: {
          status: r.holders.status,
          progress: r.holders.progress,
          holderCount: r.holders.holderCount,
          breakdown: r.holders.breakdown,
          drift: r.holders.drift,
          top5: r.holders.top.slice(0, 5).map((h) => ({
            address: h.address,
            kind: h.label,
            percentOfSupply: h.percent,
          })),
        },
        signals: r.signals,
        instruction:
          `${shown} In two to four sentences, say what stands out and which ` +
          'signals matter most. If holders are not ready, say they are still ' +
          'being counted.',
      });
    }

    if (step.kind === 'top_tokens') {
      const t = step as {
        window: string;
        observedMinutes: number;
        tokens: Array<{ rank: number; symbol: string; address: string; volumeUsd: Record<string, number | null>; marketCap: number | null }>;
      };
      return JSON.stringify({
        window: t.window,
        observedMinutes: t.observedMinutes,
        tokens: t.tokens.map((x) => ({
          rank: x.rank,
          symbol: x.symbol,
          address: x.address,
          volumeUsd: x.volumeUsd[t.window] ?? null,
          marketCap: x.marketCap,
        })),
        instruction:
          `${shown} Use these addresses if you need to look further (e.g. ` +
          'find_common_holders). Otherwise comment briefly on what leads.',
      });
    }

    if (step.kind === 'holder_overlap') {
      const o = step as {
        tokens: Array<{ symbol: string; address: string; status: string; progress: number; holdersCompared: number }>;
        overlaps: Array<{ address: string; tokens: Array<{ symbol: string; rank: number; percent: number | null }> }>;
        topN: number;
        include: string[];
      };
      const compared = o.tokens.filter((t) => t.status === 'ready');
      return JSON.stringify({
        compared: compared.map((t) => t.symbol),
        stillCounting: o.tokens
          .filter((t) => t.status !== 'ready')
          .map((t) => `${t.symbol} (${t.status}${t.progress ? `, ${t.progress}%` : ''})`),
        topHoldersComparedPerToken: o.topN,
        holderKinds: o.include,
        overlapCount: o.overlaps.length,
        strongest: o.overlaps.slice(0, 5).map((h) => ({
          address: h.address,
          holds: h.tokens.map((t) => `${t.symbol} #${t.rank}${t.percent != null ? ` (${t.percent.toFixed(2)}%)` : ''}`),
        })),
        instruction:
          compared.length < 2
            ? // With one token counted there was nothing to compare against.
              // "No overlaps found" would state a result that was never computed.
              `${shown} Fewer than two of these tokens have their holders ` +
              'counted, so no comparison was possible yet. Say exactly that ' +
              '— do NOT say that no overlaps exist — and that the card will ' +
              'offer to update the results as the rest finish counting.'
            : `${shown} Summarise in two or three sentences: how many addresses ` +
              'overlap, the most notable one, and which tokens were not compared ' +
              'yet. If there are no overlaps among the compared tokens, say that ' +
              'plainly and name which tokens it covered.',
      });
    }

    if (step.kind === 'portfolio') {
      // Totals and the few biggest positions: enough to say something useful,
      // not rows to recite. Handed the full holdings list, the model wrote it
      // out as a markdown table above the card that already shows it.
      const p = step as {
        mode?: string;
        totalUsd: number;
        netDepositsUsd?: number;
        totalReturnUsd?: number;
        totalReturnPct?: number | null;
        realizedUsd?: number;
        unpricedCount: number;
        holdings: Array<{ symbol: string; valueUsd: number | null; pnlUsd?: number | null; pnlPct?: number | null }>;
      };
      return JSON.stringify({
        mode: p.mode ?? 'live',
        totalUsd: p.totalUsd,
        netDepositsUsd: p.netDepositsUsd,
        totalReturnUsd: p.totalReturnUsd,
        totalReturnPct: p.totalReturnPct,
        realizedUsd: p.realizedUsd,
        unrealizedUsd: (p as { unrealizedUsd?: number }).unrealizedUsd,
        feesUsd: (p as { feesUsd?: number }).feesUsd,
        cashUsd: (p as { cashUsd?: number }).cashUsd,
        holdingCount: p.holdings.length,
        unpricedCount: p.unpricedCount,
        largest: p.holdings.slice(0, 3).map((h) => ({
          symbol: h.symbol,
          valueUsd: h.valueUsd,
          pnlUsd: h.pnlUsd ?? null,
          pnlPct: h.pnlPct ?? null,
        })),
        instruction:
          `${shown} The card is the whole answer and your text is not displayed ` +
          'with it. Reply with one short sentence at most — no table, no list, ' +
          'no balances, no questions.',
      });
    }

    if (step.kind === 'wallet_holdings') {
      return JSON.stringify({
        ...JSON.parse(original),
        instruction: `${shown} Comment briefly on what stands out.`,
      });
    }

    if (step.kind !== 'token_choices') return original;

    const candidates = (step.candidates ?? []) as Array<{
      address?: string;
      symbol?: string;
      name?: string;
      marketCap?: number | null;
      poolCount?: number;
    }>;

    if (candidates.length === 0) {
      return JSON.stringify({ kind: step.kind, candidates: [], note: step.note });
    }

    // Addresses stay in. An earlier version withheld them to stop the model
    // reciting the list, and the model then invented an address to pass to
    // get_token_report — the report came back "not a token" for a real one.
    return JSON.stringify({
      shown_to_user_as_cards: candidates.length,
      candidates: candidates.map((c) => ({
        symbol: c.symbol,
        name: c.name,
        address: c.address,
        marketCap: c.marketCap ?? null,
      })),
      instruction:
        candidates.length === 1
          ? 'One match. Use its address with get_token_report if the user wants ' +
            'to know about it. Do not list it back.'
          : 'The user can see every candidate as a clickable card. Do NOT list ' +
            'them. If one is plainly the real token (far larger market cap), ' +
            'use its address; otherwise say in one or two sentences how they ' +
            'differ and ask which one they mean. Only ever use addresses from ' +
            'this list.',
    });
  }

  /** Caps what a card carries into the database. */
  private forStorage(step: Record<string, unknown>): Record<string, unknown> {
    if (step.kind === 'holder_overlap' && Array.isArray(step.overlaps)) {
      return {
        ...step,
        overlaps: step.overlaps.slice(0, MAX_STORED_OVERLAPS),
        overlapTotal: step.overlaps.length,
      };
    }
    return step;
  }

  /** A tool result is a renderable step if it parses and carries a known kind. */
  private asStep(text: string): Record<string, unknown> | null {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const kind = parsed?.kind;
      return typeof kind === 'string' && RENDERABLE_STEPS.has(kind)
        ? parsed
        : null;
    } catch {
      return null;
    }
  }

  private async runTool(
    session: McpSession,
    call: ToolCall,
    onToolCall?: ToolCallListener,
  ): Promise<string> {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
    } catch {
      // Malformed arguments are the model's mistake to fix, so tell it rather
      // than failing the turn.
      onToolCall?.({
        id: call.id,
        name: call.function.name,
        input: {},
        status: 'failed',
        error: 'arguments were not valid JSON',
      });
      return 'Tool error: arguments were not valid JSON.';
    }

    onToolCall?.({
      id: call.id,
      name: call.function.name,
      input: args,
      status: 'started',
    });

    const text = await session.call(call.function.name, args);
    const failed = text.startsWith('Tool error:');

    onToolCall?.({
      id: call.id,
      name: call.function.name,
      input: args,
      status: failed ? 'failed' : 'completed',
      ...(failed ? { error: text } : {}),
    });

    return text;
  }
}
