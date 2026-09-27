import { setDefaultAutoSelectFamilyAttemptTimeout } from 'node:net';
import { HttpAdapterHost, NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module';
import { DbUnavailableFilter } from './database/db-unavailable.filter';
import { resolveNetwork } from './chain/networks';

// Node tries each of a host's addresses in turn and, by default, gives each
// only 250ms to answer before moving on. From here a TCP handshake to Neon
// (AWS us-east-2) or the RPC routinely takes longer than that, so reachable
// servers failed with ETIMEDOUT in under a second — the "connection timeout"
// and "fetch failed" errors seen all day. 2.5s per address fixes the cause;
// it only slows failover when an address is truly dead.
setDefaultAutoSelectFamilyAttemptTimeout(2_500);

async function bootstrap() {
  // Printed before anything connects, so the network in play is the first
  // thing in the log rather than something you infer later from a failure.
  const net = resolveNetwork(process.env);
  new Logger('bootstrap').log(
    `network=${net.name} chain=${net.chainId} ` +
      `funds=${net.realFunds ? 'REAL' : 'test'}`,
  );

  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);

  // Sessions live in httpOnly cookies, which Nest does not parse by default.
  // So SIGTERM from a watch restart closes the database and stops background
  // indexers between chunks, rather than killing them mid-write.
  app.enableShutdownHooks();
  app.useGlobalFilters(new DbUnavailableFilter(app.get(HttpAdapterHost).httpAdapter));
  // Backstop: if a graceful shutdown has not finished in 10s, exit anyway. A
  // hung shutdown once left an orphaned server holding :9000, so every
  // watch-mode restart failed with EADDRINUSE while the zombie answered
  // requests with a closed database pool.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      setTimeout(() => {
        new Logger('bootstrap').error(`shutdown took over 10s after ${signal}; forcing exit`);
        process.exit(1);
      }, 10_000).unref();
    });
  }
  app.use(cookieParser());

  const allowed = config
    .getOrThrow<string>('CORS_ORIGIN')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  const lenient = process.env.NODE_ENV !== 'production';
  const LOCALHOST = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

  app.enableCors({
    origin(
      origin: string | undefined,
      cb: (err: Error | null, allow?: boolean) => void,
    ) {
      // No Origin header at all: curl, server-to-server, same-origin. Nothing
      // to enforce against, and blocking it only breaks health checks.
      if (!origin) return cb(null, true);
      if (allowed.includes(origin)) return cb(null, true);
      if (lenient && LOCALHOST.test(origin)) return cb(null, true);
      // Refuse by omitting the CORS headers, which the browser enforces. Passing
      // an Error here turned an ordinary refusal into a 500, which reads in the
      // logs as the server failing rather than doing its job.
      cb(null, false);
    },
    credentials: true,
  });

  const port = config.getOrThrow<number>('PORT');
  await app.listen(port);
  new Logger('bootstrap').log(`Arena 67 backend listening on :${port}`);
}

// The indexers, scanners and caches run in the background against a remote
// database and a public RPC; a stray rejection from one of them is logged, not
// allowed to take the whole server (and every user's session) down with it.
process.on('unhandledRejection', (reason) => {
  new Logger('process').error(
    `unhandled rejection: ${(reason as Error)?.message?.split('\n')[0] ?? String(reason)}`,
  );
});

// A startup that fails for real says so in one line and exits non-zero,
// rather than dying on an unhandled rejection with a raw stack trace.
bootstrap().catch((err: Error) => {
  new Logger('bootstrap').error(`backend failed to start: ${err.message?.split('\n')[0] ?? err}`);
  process.exit(1);
});
