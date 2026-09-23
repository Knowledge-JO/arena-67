import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module';
import { resolveNetwork } from './chain/networks';

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

  const allowed = config
    .getOrThrow<string>('CORS_ORIGIN')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  const lenient = process.env.NODE_ENV !== 'production';
  const LOCALHOST = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

  app.enableCors({
    origin(origin, cb) {
      // No Origin header at all: curl, server-to-server, same-origin. Nothing
      // to enforce against, and blocking it only breaks health checks.
      if (!origin) return cb(null, true);
      if (allowed.includes(origin)) return cb(null, true);
      if (lenient && LOCALHOST.test(origin)) return cb(null, true);
      cb(new Error(`Origin ${origin} is not allowed by CORS_ORIGIN.`));
    },
    credentials: true,
  });

  const port = config.getOrThrow<number>('PORT');
  await app.listen(port);
  new Logger('bootstrap').log(`Arena 67 backend listening on :${port}`);
}

void bootstrap();
