import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomBytes } from 'node:crypto';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { DRIZZLE } from '../database/database.constants';
import { dbOf, type Database } from '../database/database.module';
import { loginCodes, refreshTokens, users } from '../database/schema';
import { MailService } from '../mail/mail.service';
import { UserWalletService } from '../accounts/user-wallet.service';
import {
  ACCESS_TTL_SECONDS,
  CODE_MAX_ATTEMPTS,
  CODE_TTL_MS,
  REFRESH_TTL_SECONDS,
} from './auth.constants';
import { codesMatch, generateCode, hashCode, hashToken, normaliseEmail } from './otp';
import { RateLimiter } from './rate-limit';

export interface AccessClaims {
  sub: string;
  email: string;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

export const MCP_AUDIENCE = 'arena67-mcp';
export const ACCESS_AUDIENCE = 'arena67-web';

/** Every wrong-code outcome returns this, so the reason is not an oracle. */
const INVALID_CODE = 'That code is invalid or has expired.';

@Injectable()
export class AuthService {
  private readonly log = new Logger(AuthService.name);
  private readonly db: Database;

  // Per email: stops someone flooding one inbox. Per IP: stops one client
  // cycling through addresses. Neither alone covers both abuses.
  private readonly perEmail = new RateLimiter(3, 10 * 60 * 1000);
  private readonly perIp = new RateLimiter(10, 10 * 60 * 1000);

  constructor(
    @Inject(DRIZZLE) handle: unknown,
    private readonly jwt: JwtService,
    private readonly mail: MailService,
    private readonly walletsService: UserWalletService,
  ) {
    this.db = dbOf(handle);
  }

  /**
   * Sends a login code. Sign-up and login are the same call.
   *
   * The response is identical whether or not the email has an account. A
   * separate "no account for that address" answer would let anyone check who
   * is a user — and on a product holding wallets, that list is worth having.
   */
  async requestCode(rawEmail: string, ip: string): Promise<void> {
    const email = normaliseEmail(rawEmail);

    const waitEmail = this.perEmail.take(email);
    const waitIp = this.perIp.take(ip);
    const wait = Math.max(waitEmail, waitIp);
    if (wait > 0) {
      throw new HttpException(
        `Too many codes requested. Try again in ${wait}s.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const code = generateCode();

    await this.db.transaction(async (tx) => {
      // Only the newest code works. Without this, requesting three codes
      // leaves three live ones, tripling the guessing surface.
      await tx
        .update(loginCodes)
        .set({ supersededAt: new Date() })
        .where(
          and(
            eq(loginCodes.email, email),
            isNull(loginCodes.usedAt),
            isNull(loginCodes.supersededAt),
          ),
        );
      await tx.insert(loginCodes).values({
        email,
        codeHash: hashCode(email, code),
        expiresAt: new Date(Date.now() + CODE_TTL_MS),
        requestIp: ip,
      });
    });

    await this.mail.sendLoginCode(email, code);
  }

  /**
   * Verifies a code and signs the user in, creating the account and its
   * wallet on first use.
   */
  /**
   * Validates and consumes a code: expiry, attempt burn, constant-time match,
   * and a single-use claim that holds under concurrency. Shared by sign-in and
   * by step-up checks such as key export, so that logic exists exactly once —
   * a second copy is where a check quietly goes missing.
   */
  private async consumeCode(email: string, code: string): Promise<void> {

    const row = await this.db.query.loginCodes.findFirst({
      where: and(
        eq(loginCodes.email, email),
        isNull(loginCodes.usedAt),
        isNull(loginCodes.supersededAt),
      ),
      orderBy: desc(loginCodes.createdAt),
    });

    if (!row || row.expiresAt.getTime() < Date.now()) {
      throw new UnauthorizedException(INVALID_CODE);
    }
    if (row.attempts >= CODE_MAX_ATTEMPTS) {
      throw new UnauthorizedException(INVALID_CODE);
    }

    if (!codesMatch(row.codeHash, email, code)) {
      // Atomic increment: two parallel guesses must both count, or an
      // attacker gets more than five tries by racing them.
      await this.db
        .update(loginCodes)
        .set({ attempts: sql`${loginCodes.attempts} + 1` })
        .where(eq(loginCodes.id, row.id));
      throw new UnauthorizedException(INVALID_CODE);
    }

    // Claim the code. The `used_at IS NULL` condition makes this the single
    // point of truth under concurrency: if two requests present the right
    // code at once, exactly one update matches a row and the other gets none.
    const claimed = await this.db
      .update(loginCodes)
      .set({ usedAt: new Date() })
      .where(and(eq(loginCodes.id, row.id), isNull(loginCodes.usedAt)))
      .returning({ id: loginCodes.id });
    if (claimed.length === 0) throw new UnauthorizedException(INVALID_CODE);
  }

  async verifyCode(
    rawEmail: string,
    code: string,
  ): Promise<{ tokens: TokenPair; userId: string; isNewUser: boolean }> {
    const email = normaliseEmail(rawEmail);
    await this.consumeCode(email, code);

    const { userId, isNewUser } = await this.db.transaction(async (tx) => {
      const existing = await tx.query.users.findFirst({ where: eq(users.email, email) });
      if (existing) {
        await tx.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, existing.id));
        return { userId: existing.id, isNewUser: false };
      }
      const [created] = await tx
        .insert(users)
        .values({ email, lastLoginAt: new Date() })
        .returning({ id: users.id });
      // Same transaction as the user row — see UserWalletService.create.
      await this.walletsService.create(tx, created.id);
      return { userId: created.id, isNewUser: true };
    });

    this.log.log(`${isNewUser ? 'sign-up' : 'login'}: ${email}`);
    return { tokens: await this.issueTokens(userId, email), userId, isNewUser };
  }

  /**
   * Rotates a refresh token.
   *
   * A token that has already been revoked is treated as evidence of theft:
   * the legitimate client rotated it, so whoever presents it now copied it.
   * Every session for that user is revoked, which logs the thief out along
   * with the victim — the victim signs in again, the thief cannot.
   */
  async refresh(rawToken: string): Promise<TokenPair> {
    const hash = hashToken(rawToken);
    const row = await this.db.query.refreshTokens.findFirst({
      where: eq(refreshTokens.tokenHash, hash),
    });

    if (!row) throw new UnauthorizedException('Session expired.');

    if (row.revokedAt) {
      this.log.warn(`refresh token reuse for user ${row.userId} — revoking all sessions`);
      await this.revokeAll(row.userId);
      throw new UnauthorizedException('Session expired.');
    }
    if (row.expiresAt.getTime() < Date.now()) {
      throw new UnauthorizedException('Session expired.');
    }

    await this.db
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(eq(refreshTokens.id, row.id));

    const user = await this.db.query.users.findFirst({ where: eq(users.id, row.userId) });
    if (!user) throw new UnauthorizedException('Session expired.');
    return this.issueTokens(user.id, user.email);
  }

  async logout(rawToken: string | undefined): Promise<void> {
    if (!rawToken) return;
    await this.db
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(eq(refreshTokens.tokenHash, hashToken(rawToken)));
  }

  async verifyAccess(token: string): Promise<AccessClaims> {
    try {
      return await this.jwt.verifyAsync<AccessClaims>(token, { audience: ACCESS_AUDIENCE });
    } catch {
      throw new UnauthorizedException('Not signed in.');
    }
  }

  /**
   * Re-proves control of the inbox before a dangerous action. A live session
   * is not enough to export a private key: a session can be stolen, and an
   * export is irreversible, so it has to be the person holding the mailbox.
   */
  async stepUp(userId: string, code: string): Promise<void> {
    const user = await this.db.query.users.findFirst({ where: eq(users.id, userId) });
    if (!user) throw new UnauthorizedException(INVALID_CODE);
    await this.consumeCode(user.email, code);
  }

  /** Emails a code to the signed-in user, for a step-up check. */
  async requestStepUpCode(userId: string, ip: string): Promise<void> {
    const user = await this.db.query.users.findFirst({ where: eq(users.id, userId) });
    if (!user) throw new UnauthorizedException('Not signed in.');
    await this.requestCode(user.email, ip);
  }

  /**
   * A token that lets the MCP server act for one user, for one chat turn.
   *
   * Distinct audience from a browser access token, so neither can stand in for
   * the other: a leaked MCP token is useless as a session, and a stolen
   * session cookie cannot be replayed down the service path. Five minutes is
   * long enough for a slow multi-tool turn and short enough to be worthless
   * shortly after.
   */
  mintMcpToken(userId: string): Promise<string> {
    return this.jwt.signAsync({ sub: userId }, { audience: MCP_AUDIENCE, expiresIn: 5 * 60 });
  }

  async verifyMcpToken(token: string): Promise<string> {
    try {
      const claims = await this.jwt.verifyAsync<{ sub: string }>(token, {
        audience: MCP_AUDIENCE,
      });
      return claims.sub;
    } catch {
      throw new UnauthorizedException('Invalid user token.');
    }
  }

  private async revokeAll(userId: string): Promise<void> {
    await this.db
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));
  }

  private async issueTokens(userId: string, email: string): Promise<TokenPair> {
    const accessToken = await this.jwt.signAsync(
      { sub: userId, email } satisfies AccessClaims,
      { expiresIn: ACCESS_TTL_SECONDS, audience: ACCESS_AUDIENCE },
    );
    const refreshToken = randomBytes(32).toString('hex');
    await this.db.insert(refreshTokens).values({
      userId,
      tokenHash: hashToken(refreshToken),
      expiresAt: new Date(Date.now() + REFRESH_TTL_SECONDS * 1000),
    });
    return { accessToken, refreshToken };
  }
}
