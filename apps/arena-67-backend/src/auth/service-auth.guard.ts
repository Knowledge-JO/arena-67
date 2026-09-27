import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';

/** Header the MCP server presents. Bearer is accepted too, for curl. */
export const SERVICE_HEADER = 'x-arena-service';

export interface ServiceRequest extends Request {
  /** True when this request proved knowledge of the shared secret. */
  isService?: boolean;
}

/**
 * Identifies calls that come from our own services rather than a browser.
 *
 * The backend had no notion of a caller at all: the MCP server was just
 * another anonymous HTTP client, indistinguishable from anything else that
 * could reach port 9000. This gives the two halves a shared secret so the
 * backend can tell them apart.
 *
 * It is an identifier by default, not a gate. The browser UI calls these same
 * endpoints and cannot hold a secret — anything shipped to a client is public
 * — so requiring one everywhere would simply break the app or push a
 * credential into JavaScript, which is worse than having none. Setting
 * REQUIRE_SERVICE_AUTH turns it into a hard gate, for deployments where the
 * backend is reachable only by our own services.
 */
@Injectable()
export class ServiceAuthGuard implements CanActivate {
  private readonly log = new Logger(ServiceAuthGuard.name);
  private warned = false;

  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<ServiceRequest>();
    const secret = this.config.get<string>('SERVICE_SECRET')?.trim();
    const required = this.config.get<boolean>('REQUIRE_SERVICE_AUTH');

    if (!secret) {
      if (required) {
        // Refusing to start the gate without a key is the safe direction:
        // the alternative is a lock that silently opens for everyone.
        throw new UnauthorizedException(
          'REQUIRE_SERVICE_AUTH is set but SERVICE_SECRET is empty.',
        );
      }
      if (!this.warned) {
        this.warned = true;
        this.log.warn(
          'SERVICE_SECRET is unset — callers cannot be identified. Fine for ' +
            'local work; set it before exposing this backend.',
        );
      }
      req.isService = false;
      return true;
    }

    req.isService = this.matches(req, secret);

    if (required && !req.isService) {
      throw new UnauthorizedException('This backend requires a service token.');
    }
    return true;
  }

  private matches(req: ServiceRequest, secret: string): boolean {
    const header = req.headers[SERVICE_HEADER];
    const auth = req.headers.authorization;
    const presented =
      (Array.isArray(header) ? header[0] : header)?.trim() ??
      auth?.replace(/^Bearer\s+/i, '').trim();

    if (!presented) return false;

    // Constant-time, and length-guarded because timingSafeEqual throws on a
    // length mismatch — which would itself leak the secret's length.
    const a = Buffer.from(presented);
    const b = Buffer.from(secret);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }
}
