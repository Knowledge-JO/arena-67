import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { TradingService, type TradeStep } from './trading.service';
import { TradeIntentSchema } from '../openserv/schemas';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser, type AuthedUser } from '../auth/current-user.decorator';
import { UserWalletService } from '../accounts/user-wallet.service';

/**
 * Turns a schema failure into a 400 naming the offending field, rather than a
 * raw ZodError that Nest would surface as a blank 500.
 */
function parse<T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> {
  const result = schema.safeParse(body);
  if (result.success) return result.data;
  throw new BadRequestException(
    result.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '),
  );
}

// No `sessionId` in any body. It used to come from the client, which meant the
// caller chose whose trade it was acting on. The owner is now whoever the
// verified token says it is, and nothing the client sends can change that.
const BeginBody = z.object({ intent: TradeIntentSchema });
const SelectBody = z.object({ intentId: z.string().uuid(), candidateId: z.string().uuid() });
const AmountBody = z
  .object({
    intentId: z.string().uuid(),
    amount: z.number().positive().optional(),
    percent: z.number().positive().max(100).optional(),
  })
  .refine((b) => (b.amount == null) !== (b.percent == null), 'Give either an amount or a percent');
const ConfirmBody = z.object({ intentId: z.string().uuid(), quoteId: z.string().uuid() });
const SelectPoolBody = z.object({
  intentId: z.string().uuid(),
  poolId: z.string().regex(/^0x[a-fA-F0-9]{64}$/, 'Must be a 32-byte pool id'),
});
const RequoteBody = z.object({ intentId: z.string().uuid() });

@Controller('trade')
@UseGuards(JwtAuthGuard)
export class TradingController {
  constructor(
    private readonly trading: TradingService,
    private readonly wallets: UserWalletService,
  ) {}

  /** The caller's own wallet: where to deposit, and what it holds in ETH. */
  @Get('wallet')
  async wallet(@CurrentUser() user: AuthedUser) {
    const { address, eth } = await this.wallets.nativeBalance(user.id);
    return { address, eth, available: true };
  }

  @Post('begin')
  @HttpCode(200)
  begin(@CurrentUser() user: AuthedUser, @Body() body: unknown): Promise<TradeStep> {
    const { intent } = parse(BeginBody, body);
    return this.trading.begin(user.id, intent);
  }

  @Post('select-token')
  @HttpCode(200)
  select(@CurrentUser() user: AuthedUser, @Body() body: unknown): Promise<TradeStep> {
    const { intentId, candidateId } = parse(SelectBody, body);
    return this.trading.selectToken(user.id, intentId, candidateId);
  }

  @Post('amount')
  @HttpCode(200)
  amount(@CurrentUser() user: AuthedUser, @Body() body: unknown): Promise<TradeStep> {
    const { intentId, amount, percent } = parse(AmountBody, body);
    return percent != null
      ? this.trading.setPercent(user.id, intentId, percent)
      : this.trading.setAmount(user.id, intentId, amount!);
  }

  @Post('select-pool')
  @HttpCode(200)
  selectPool(@CurrentUser() user: AuthedUser, @Body() body: unknown): Promise<TradeStep> {
    const { intentId, poolId } = parse(SelectPoolBody, body);
    return this.trading.selectPool(user.id, intentId, poolId);
  }

  @Post('requote')
  @HttpCode(200)
  requote(@CurrentUser() user: AuthedUser, @Body() body: unknown): Promise<TradeStep> {
    const { intentId } = parse(RequoteBody, body);
    return this.trading.requote(user.id, intentId);
  }

  /**
   * Signs. Deliberately unreachable from the MCP path: a model-driven request
   * carries a user token, and signing must only ever follow a person clicking
   * confirm in their own browser session.
   */
  @Post('confirm')
  @HttpCode(200)
  confirm(@CurrentUser() user: AuthedUser, @Body() body: unknown): Promise<TradeStep> {
    if (user.via !== 'session') {
      throw new BadRequestException('Trades are confirmed by the user in the app.');
    }
    const { intentId, quoteId } = parse(ConfirmBody, body);
    return this.trading.confirm(user.id, intentId, quoteId);
  }
}
