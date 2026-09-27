import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';
import { ACCESS_COOKIE } from './auth.constants';
import type { AuthedRequest } from './current-user.decorator';

/** Header carrying a per-turn user token from the MCP server. */
export const MCP_USER_HEADER = 'x-arena-user';

/**
 * Resolves who a request is for. Two ways in, and they are not equivalent.
 *
 * **Browser** — the access JWT from an httpOnly cookie. JavaScript cannot read
 * that cookie, so an XSS bug cannot lift a session that controls a wallet.
 *
 * **MCP server** — a short-lived per-turn user token, honoured *only* when the
 * request also carries the service secret. The model drives the MCP server,
 * and the whole point is that a user's identity never passes through anything
 * the model writes: it rides in a header the backend minted, not in a tool
 * argument a prompt injection could rewrite.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();

    const mcpToken = this.header(req, MCP_USER_HEADER);
    if (mcpToken) {
      // Without the service secret this header means nothing. Honouring it
      // bare would let any caller who obtained one user token skip the
      // service boundary entirely.
      if (!req.isService) throw new UnauthorizedException('User tokens require a service caller.');
      const userId = await this.auth.verifyMcpToken(mcpToken);
      req.user = { id: userId, email: null, via: 'mcp' };
      return true;
    }

    const token =
      req.cookies?.[ACCESS_COOKIE] ??
      this.header(req, 'authorization')?.replace(/^Bearer\s+/i, '');
    if (!token) throw new UnauthorizedException('Not signed in.');

    const claims = await this.auth.verifyAccess(token);
    req.user = { id: claims.sub, email: claims.email, via: 'session' };
    return true;
  }

  private header(req: AuthedRequest, name: string): string | undefined {
    const v = req.headers[name];
    return (Array.isArray(v) ? v[0] : v)?.trim() || undefined;
  }
}
