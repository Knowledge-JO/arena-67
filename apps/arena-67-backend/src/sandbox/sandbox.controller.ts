import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser, type AuthedUser } from '../auth/current-user.decorator';
import { SandboxService } from './sandbox.service';

const ModeBody = z.object({ mode: z.enum(['sandbox', 'live']) });
const DepositBody = z.object({
  asset: z.enum(['ETH', 'USDG']),
  // A string, so "0.1" arrives as typed rather than as a float.
  amount: z.union([z.string(), z.number()]).transform((v) => String(v)),
});

function parse<S extends z.ZodTypeAny>(schema: S, value: unknown): z.output<S> {
  const r = schema.safeParse(value);
  if (!r.success) throw new BadRequestException(r.error.issues.map((i) => i.message).join('; '));
  return r.data;
}

/**
 * The sandbox switch and the paper account.
 *
 * Switching modes and resetting are the person's decisions, made in the app.
 * A request arriving with the MCP token — the model acting in a chat — is
 * refused for both: text in a conversation must never be able to move someone
 * from paper money onto their real wallet. Adding paper funds is allowed from
 * chat; it cannot cost anything.
 */
@Controller()
@UseGuards(JwtAuthGuard)
export class SandboxController {
  constructor(private readonly sandbox: SandboxService) {}

  @Get('account/mode')
  async getMode(@CurrentUser() user: AuthedUser) {
    return { mode: await this.sandbox.mode(user.id) };
  }

  @Put('account/mode')
  async setMode(@CurrentUser() user: AuthedUser, @Body() body: unknown) {
    this.sessionOnly(user);
    const { mode } = parse(ModeBody, body);
    return { mode: await this.sandbox.setMode(user.id, mode) };
  }

  /** The paper account, valued. What the wallet box shows in sandbox. */
  @Get('sandbox')
  summary(@CurrentUser() user: AuthedUser) {
    return this.sandbox.portfolio(user.id);
  }

  @Post('sandbox/deposit')
  @HttpCode(200)
  async deposit(@CurrentUser() user: AuthedUser, @Body() body: unknown) {
    const { asset, amount } = parse(DepositBody, body);
    const { valueUsd } = await this.sandbox.deposit(user.id, asset, amount);
    return { ok: true, asset, amount, valueUsd, portfolio: await this.sandbox.portfolio(user.id) };
  }

  @Post('sandbox/reset')
  @HttpCode(200)
  async reset(@CurrentUser() user: AuthedUser) {
    this.sessionOnly(user);
    await this.sandbox.reset(user.id);
    return { ok: true, portfolio: await this.sandbox.portfolio(user.id) };
  }

  private sessionOnly(user: AuthedUser): void {
    if (user.via !== 'session') {
      throw new ForbiddenException('Only you can do this, from the app — not the assistant.');
    }
  }
}
