jest.mock('@nestjs/config', () => ({ ConfigService: class {} }));

import { Logger } from '@nestjs/common';
import { isConnectionError } from './connection-errors';
import { retryConnect } from './database.module';

/** The shape from the live failure: Drizzle wrapping pg-pool's connect timeout. */
function drizzleConnectTimeout() {
  const inner = new Error('Connection terminated unexpectedly');
  const cause = Object.assign(new Error('Connection terminated due to connection timeout'), { cause: inner });
  return Object.assign(new Error('Failed query: select "id" from "conversations" ...'), { cause });
}

describe('isConnectionError', () => {
  it('recognises the live failure through Drizzle’s wrapper', () => {
    expect(isConnectionError(drizzleConnectTimeout())).toBe(true);
  });
  it('recognises network codes', () => {
    expect(isConnectionError(Object.assign(new Error('x'), { code: 'ETIMEDOUT' }))).toBe(true);
    expect(isConnectionError(Object.assign(new Error('x'), { code: 'ENETUNREACH' }))).toBe(true);
  });
  it('does not treat a rejected query as an outage', () => {
    const e = Object.assign(new Error('Failed query'), {
      cause: Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' }),
    });
    expect(isConnectionError(e)).toBe(false);
  });
});

describe('retryConnect', () => {
  const log = { warn: jest.fn() } as unknown as Logger;
  const client = { release: jest.fn() };

  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('retries connection failures and then succeeds (promise form)', async () => {
    const connect = jest
      .fn()
      .mockRejectedValueOnce(new Error('Connection terminated due to connection timeout'))
      .mockResolvedValueOnce(client);
    const pool = { connect } as never;
    retryConnect(pool, log);
    const p = (pool as { connect: () => Promise<unknown> }).connect();
    await jest.advanceTimersByTimeAsync(600);
    await expect(p).resolves.toBe(client);
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('serves pg-pool’s internal callback form', async () => {
    const pool = { connect: jest.fn().mockResolvedValue(client) } as never;
    retryConnect(pool, log);
    const got = await new Promise((resolve) =>
      (pool as { connect: (cb: (e: unknown, c: unknown) => void) => void }).connect((e, c) => resolve([e, c])),
    );
    expect(got).toEqual([undefined, client]);
  });

  it('does not retry an error that is not about connecting', async () => {
    const connect = jest.fn().mockRejectedValue(new Error('password authentication failed'));
    const pool = { connect } as never;
    retryConnect(pool, log);
    await expect((pool as { connect: () => Promise<unknown> }).connect()).rejects.toThrow('password');
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('gives up after three attempts', async () => {
    const connect = jest.fn().mockRejectedValue(Object.assign(new Error('x'), { code: 'ETIMEDOUT' }));
    const pool = { connect } as never;
    retryConnect(pool, log);
    const p = (pool as { connect: () => Promise<unknown> }).connect();
    const settled = p.catch((e: Error) => e);
    await jest.advanceTimersByTimeAsync(5_000);
    expect(await settled).toBeInstanceOf(Error);
    expect(connect).toHaveBeenCalledTimes(3);
  });
});
