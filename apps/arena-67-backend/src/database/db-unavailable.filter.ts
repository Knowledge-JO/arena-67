import { ArgumentsHost, Catch, HttpStatus, Logger } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import type { Response } from 'express';
import { isConnectionError } from './connection-errors';

/**
 * An unreachable database is a temporary condition, not a bug, so it is
 * answered as one: 503 with a message a person can act on, instead of a 500
 * "Internal server error". Everything else goes to Nest's default handling.
 */
@Catch()
export class DbUnavailableFilter extends BaseExceptionFilter {
  private readonly log = new Logger('Database');

  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() === 'http' && isConnectionError(exception)) {
      this.log.warn(`request failed, database unreachable: ${(exception as Error).message?.split('\n')[0]}`);
      host
        .switchToHttp()
        .getResponse<Response>()
        .status(HttpStatus.SERVICE_UNAVAILABLE)
        .json({
          statusCode: HttpStatus.SERVICE_UNAVAILABLE,
          message: 'Can’t reach the database right now. Please try again in a moment.',
        });
      return;
    }
    super.catch(exception, host);
  }
}
