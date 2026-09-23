import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Agent, run, type RunResult } from '@openserv-labs/sdk';
import { z } from 'zod';
import { TradeIntentSchema } from './schemas';
import { TradingService, type TradeStep } from '../trading/trading.service';

const SYSTEM_PROMPT = `You are Arena 67, a memecoin trading desk on Robinhood Chain.

Rules you never break:
- Never invent or infer a contract address. If the user names a token by
  ticker, call prepare_trade with the ticker only and leave contractAddress
  unset. The desk resolves it.
- Never assume an amount. If the user has not said how much, leave amount unset.
- Never claim a trade happened. Only the desk's own reply reports a fill.`;

/**
 * Hosts the OpenServ agent and bridges its capabilities to the trading desk.
 *
 * Extraction is done by the OpenServ runtime itself: it reads the Zod schema
 * on each capability and fills it from the conversation. That is why this
 * needs no OpenAI key — `generate()` and `process()` both want one (or a task
 * action for billing), but runtime-driven capability calls want neither.
 *
 * `run()` opens a tunnel to the OpenServ proxy, so the agent is reachable from
 * the platform without a public URL or ngrok.
 */
@Injectable()
export class ArenaAgentService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(ArenaAgentService.name);
  private agent!: Agent;
  private runner: RunResult | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly trading: TradingService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.agent = new Agent({
      systemPrompt: SYSTEM_PROMPT,
      apiKey: this.config.getOrThrow<string>('OPENSERV_AI_API_KEY'),
    });

    this.agent.addCapability({
      name: 'prepare_trade',
      description:
        'Start a buy or sell of a memecoin on Robinhood Chain. Call this as ' +
        'soon as the user expresses intent, even if you do not know the token ' +
        'address or the amount yet.',
      inputSchema: TradeIntentSchema,
      run: async ({ args, action }) =>
        this.render(await this.trading.begin(this.sessionOf(action), args)),
    });

    this.agent.addCapability({
      name: 'set_trade_amount',
      description:
        'Supply the amount for a trade that is already waiting on one.',
      inputSchema: z.object({
        intentId: z.string().describe('The id of the trade being filled in.'),
        amount: z.number().positive().describe('How much to spend or sell.'),
      }),
      run: async ({ args, action }) =>
        this.render(
          await this.trading.setAmount(
            this.sessionOf(action),
            args.intentId,
            args.amount,
          ),
        ),
    });

    this.agent.addCapability({
      name: 'confirm_trade',
      description:
        'Sign and broadcast a quoted trade. Only call this after the user has ' +
        'seen the quote and explicitly agreed to it.',
      inputSchema: z.object({
        intentId: z.string().describe('The id of the quoted trade.'),
        quoteId: z.string().describe('The id of the quote the user accepted.'),
      }),
      run: async ({ args, action }) =>
        this.render(
          await this.trading.confirm(
            this.sessionOf(action),
            args.intentId,
            args.quoteId,
          ),
        ),
    });

    this.runner = await run(this.agent);
    this.log.log('OpenServ agent running; tunnel open to the SERV proxy');
  }

  async onModuleDestroy(): Promise<void> {
    await this.runner?.stop();
  }

  /**
   * Scopes intents to an OpenServ workspace, so the store's ownership check
   * means something. Falls back to the task id if no workspace is present.
   */
  private sessionOf(action: unknown): string {
    const a = action as
      | { workspace?: { id?: number | string }; task?: { id?: number | string } }
      | undefined;
    const id = a?.workspace?.id ?? a?.task?.id;
    if (id === undefined) throw new Error('No OpenServ workspace in context.');
    return `openserv:${id}`;
  }

  /** Capabilities must return a string; our own UI reads the structured step. */
  private render(step: TradeStep): string {
    switch (step.kind) {
      case 'choose_token':
        return [
          step.message,
          ...(step.candidates ?? []).map(
            (c) =>
              `- ${c.symbol} (${c.name}) — ${c.address}` +
              (c.warnings.length ? ` [${c.warnings.join(', ')}]` : ''),
          ),
          `Reply with the address you want. Trade id: ${step.intentId}`,
        ].join('\n');
      case 'need_token':
      case 'need_amount':
        return `${step.message} (trade id: ${step.intentId})`;
      case 'confirm':
        return [
          step.message,
          ...Object.entries(step.summary).map(([k, v]) => `- ${k}: ${v}`),
          `Confirm with trade id ${step.intentId} and quote id ${step.quoteId}.`,
        ].join('\n');
      case 'executed':
        return `${step.message}\n${step.explorerUrl}`;
      case 'rejected':
        return step.message;
    }
  }
}
