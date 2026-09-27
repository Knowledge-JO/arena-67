import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Ip,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { AuthService, type TokenPair } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { CurrentUser, type AuthedUser } from './current-user.decorator';
import {
  ACCESS_COOKIE,
  ACCESS_TTL_SECONDS,
  CODE_LENGTH,
  REFRESH_COOKIE,
  REFRESH_TTL_SECONDS,
} from './auth.constants';
import { UserWalletService } from '../accounts/user-wallet.service';
import { SandboxService } from '../sandbox/sandbox.service';

const EmailBody = z.object({ email: z.string().trim().email().max(254) });
const VerifyBody = EmailBody.extend({
  code: z.string().trim().regex(new RegExp(`^\\d{${CODE_LENGTH}}$`), 'Enter the 6-digit code'),
});

function parse<T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> {
  const r = schema.safeParse(body);
  if (r.success) return r.data;
  throw new BadRequestException(r.error.issues.map((i) => i.message).join('; '));
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly wallets: UserWalletService,
    private readonly sandbox: SandboxService,
  ) {}

  /** Same response for a new address and a known one — no account oracle. */
  @Post('code')
  @HttpCode(200)
  async code(@Body() body: unknown, @Ip() ip: string) {
    const { email } = parse(EmailBody, body);
    await this.auth.requestCode(email, ip);
    return { sent: true };
  }

  @Post('verify')
  @HttpCode(200)
  async verify(@Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const { email, code } = parse(VerifyBody, body);
    const { tokens, userId, isNewUser } = await this.auth.verifyCode(email, code);
    this.setCookies(res, tokens);
    return {
      isNewUser,
      user: { id: userId, email: email.trim().toLowerCase() },
      wallet: { address: await this.wallets.addressOf(userId) },
      mode: await this.sandbox.mode(userId),
    };
  }

  @Post('refresh')
  @HttpCode(200)
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token = (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE];
    if (!token) {
      this.clearCookies(res);
      return { ok: false };
    }
    try {
      this.setCookies(res, await this.auth.refresh(token));
      return { ok: true };
    } catch {
      this.clearCookies(res);
      return { ok: false };
    }
  }

  @Post('logout')
  @HttpCode(200)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout((req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE]);
    this.clearCookies(res);
    return { ok: true };
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  async me(@CurrentUser() user: AuthedUser) {
    return {
      user: { id: user.id, email: user.email },
      wallet: { address: await this.wallets.addressOf(user.id) },
      mode: await this.sandbox.mode(user.id),
    };
  }

  /**
   * httpOnly so page JavaScript cannot read the tokens; SameSite=Lax so they
   * are not sent on cross-site POSTs; Secure outside local development. The
   * refresh cookie is scoped to /auth, so it travels only to the one endpoint
   * that needs it rather than on every API request.
   */
  private setCookies(res: Response, tokens: TokenPair): void {
    const secure = process.env.NODE_ENV === 'production';
    res.cookie(ACCESS_COOKIE, tokens.accessToken, {
      httpOnly: true,
      sameSite: 'lax',
      secure,
      path: '/',
      maxAge: ACCESS_TTL_SECONDS * 1000,
    });
    res.cookie(REFRESH_COOKIE, tokens.refreshToken, {
      httpOnly: true,
      sameSite: 'lax',
      secure,
      path: '/auth',
      maxAge: REFRESH_TTL_SECONDS * 1000,
    });
  }

  private clearCookies(res: Response): void {
    res.clearCookie(ACCESS_COOKIE, { path: '/' });
    res.clearCookie(REFRESH_COOKIE, { path: '/auth' });
  }
}
