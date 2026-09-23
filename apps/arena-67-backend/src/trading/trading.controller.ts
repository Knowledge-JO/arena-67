import {
  Body,
  Controller,
  Get,
  Post,
  HttpCode,
  BadRequestException,
} from '@nestjs/common';
import { z } from 'zod';
import { TradingService, type TradeStep } from './trading.service';
import { WalletService } from '../wallet/wallet.service';
import { TradeIntentSchema } from '../openserv/schemas';

/**
 * Session id is supplied by the caller and scopes every intent. It is the only
 * thing tying a follow-up turn to an in-flight trade, and the store checks it
 * on every read, so one session cannot drive another's trade.
 */
const SessionBody = z.object({ sessionId: z.string().min(8) });

/**
 * Turns a schema failure into a 400 naming the offending field.
 *
 * Calling `.parse` directly threw a raw ZodError, which Nest surfaced as a
 * blank 500 — an empty quoteId looked like the desk had fallen over rather
 * than like a malformed request.
 */
function parse<T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> {
  const result = schema.safeParse(body);
  if (result.success) return result.data;
  const detail = result.error.issues
    .map((i) => `${i.path.join('.') || 'body'}: ${i.message}`)
    .join('; ');
  throw new BadRequestException(detail);
}

const BeginBody = SessionBody.extend({ intent: TradeIntentSchema });
const SelectBody = SessionBody.extend({
  intentId: z.string().uuid(),
  candidateId: z.string().uuid(),
});
const AmountBody = SessionBody.extend({
  intentId: z.string().uuid(),
  amount: z.number().positive(),
});
const ConfirmBody = SessionBody.extend({
  intentId: z.string().uuid(),
  quoteId: z.string().uuid(),
});
const SelectPoolBody = SessionBody.extend({
  intentId: z.string().uuid(),
  /** 32-byte Uniswap v4 poolId. */
  poolId: z.string().regex(/^0x[a-fA-F0-9]{64}$/, 'Must be a 32-byte pool id'),
});
const RequoteBody = SessionBody.extend({ intentId: z.string().uuid() });

@Controller('trade')
export class TradingController {
  constructor(
    private readonly trading: TradingService,
    private readonly wallet: WalletService,
  ) {}

  @Get('wallet')
  wallet_() {
    return {
      address: this.wallet.addressOrNull,
      available: this.wallet.available,
      reason: this.wallet.unavailableReason,
    };
  }

  @Post('begin')
  @HttpCode(200)
  begin(@Body() body: unknown): Promise<TradeStep> {
    const { sessionId, intent } = parse(BeginBody, body);
    return this.trading.begin(sessionId, intent);
  }

  @Post('select-token')
  @HttpCode(200)
  select(@Body() body: unknown): Promise<TradeStep> {
    const { sessionId, intentId, candidateId } = parse(SelectBody, body);
    return this.trading.selectToken(sessionId, intentId, candidateId);
  }

  @Post('amount')
  @HttpCode(200)
  amount(@Body() body: unknown): Promise<TradeStep> {
    const { sessionId, intentId, amount } = parse(AmountBody, body);
    return this.trading.setAmount(sessionId, intentId, amount);
  }

  @Post('select-pool')
  @HttpCode(200)
  selectPool(@Body() body: unknown): Promise<TradeStep> {
    const { sessionId, intentId, poolId } = parse(SelectPoolBody, body);
    return this.trading.selectPool(sessionId, intentId, poolId);
  }

  @Post('requote')
  @HttpCode(200)
  requote(@Body() body: unknown): Promise<TradeStep> {
    const { sessionId, intentId } = parse(RequoteBody, body);
    return this.trading.requote(sessionId, intentId);
  }

  @Post('confirm')
  @HttpCode(200)
  confirm(@Body() body: unknown): Promise<TradeStep> {
    const { sessionId, intentId, quoteId } = parse(ConfirmBody, body);
    return this.trading.confirm(sessionId, intentId, quoteId);
  }
}
