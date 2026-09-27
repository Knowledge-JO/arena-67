import { createParamDecorator, type ExecutionContext } from '@nestjs/common';

export interface AuthedUser {
  id: string;
  email: string | null;
  /** How this request proved who it is. */
  via: 'session' | 'mcp';
}

export interface AuthedRequest {
  user?: AuthedUser;
  isService?: boolean;
  headers: Record<string, string | string[] | undefined>;
  cookies?: Record<string, string>;
}

/** The authenticated user. Only valid on routes behind JwtAuthGuard. */
export const CurrentUser = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): AuthedUser => {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    if (!req.user) throw new Error('CurrentUser used on a route without JwtAuthGuard.');
    return req.user;
  },
);
