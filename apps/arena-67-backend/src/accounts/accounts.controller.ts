import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Ip,
  Post,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser, type AuthedUser } from '../auth/current-user.decorator';
import { AuthService } from '../auth/auth.service';
import { CODE_LENGTH } from '../auth/auth.constants';
import { UserWalletService } from './user-wallet.service';
import { PortfolioService } from './portfolio.service';
import { TradeLedgerService } from './trade-ledger.service';
import { SandboxService } from '../sandbox/sandbox.service';

const ExportBody = z.object({
  code: z.string().trim().regex(new RegExp(`^\\d{${CODE_LENGTH}}$`), 'Enter the 6-digit code'),
});

@Controller('wallet')
@UseGuards(JwtAuthGuard)
export class AccountsController {
  constructor(
    private readonly wallets: UserWalletService,
    private readonly portfolio: PortfolioService,
    private readonly ledger: TradeLedgerService,
    private readonly auth: AuthService,
    private readonly sandbox: SandboxService,
  ) {}

  /** Cheap: what the balance box in the chat header polls. */
  @Get('balance')
  async balance(@CurrentUser() user: AuthedUser) {
    const { address, eth } = await this.wallets.nativeBalance(user.id);
    return { address, eth };
  }

  /** The portfolio for the mode the user is in: paper in sandbox, the wallet in live. */
  @Get('portfolio')
  async portfolioOf(@CurrentUser() user: AuthedUser) {
    if ((await this.sandbox.mode(user.id)) === 'sandbox') return this.sandbox.portfolio(user.id);
    return { ...(await this.portfolio.forUser(user.id)), mode: 'live' as const };
  }

  @Get('trades')
  async trades(@CurrentUser() user: AuthedUser) {
    if ((await this.sandbox.mode(user.id)) === 'sandbox') return this.sandbox.history(user.id, 50);
    const rows = await this.ledger.history(user.id, 50);
    return rows.map((t) => ({ ...t, mode: 'live' as const, amountIn: t.amountIn, amountOut: t.amountOut }));
  }

  /** Step 1 of export: email a fresh code to the account's own inbox. */
  @Post('export/code')
  @HttpCode(200)
  async exportCode(@CurrentUser() user: AuthedUser, @Ip() ip: string) {
    this.sessionOnly(user);
    await this.auth.requestStepUpCode(user.id, ip);
    return { sent: true };
  }

  /**
   * Step 2: the private key, in exchange for that code.
   *
   * Export exists because a custodial wallet whose key only this service holds
   * traps the user's funds the moment the service disappears. It is also the
   * single most dangerous response the API can produce, which is why it needs
   * a fresh code and never runs on the model's behalf.
   */
  @Post('export')
  @HttpCode(200)
  async export(@CurrentUser() user: AuthedUser, @Body() body: unknown) {
    this.sessionOnly(user);
    const parsed = ExportBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0].message);
    await this.auth.stepUp(user.id, parsed.data.code);
    return this.wallets.exportPrivateKey(user.id);
  }

  /** Model-driven requests carry an MCP user token; none of these are for them. */
  private sessionOnly(user: AuthedUser): void {
    if (user.via !== 'session') {
      throw new BadRequestException('This action is only available in the app.');
    }
  }
}
