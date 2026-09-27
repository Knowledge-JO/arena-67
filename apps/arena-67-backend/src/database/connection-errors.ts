/**
 * True when an error means "could not reach the database", as opposed to
 * "the database rejected this query". Walks the cause chain, since Drizzle
 * wraps the driver's error.
 */
export function isConnectionError(err: unknown): boolean {
  let e: unknown = err;
  for (let depth = 0; e && depth < 6; depth++) {
    const code = (e as { code?: string }).code;
    const message = (e as { message?: string }).message ?? '';
    if (
      code === 'ETIMEDOUT' ||
      code === 'ECONNREFUSED' ||
      code === 'ECONNRESET' ||
      code === 'ENETUNREACH' ||
      code === 'EAI_AGAIN' ||
      code === '57P01' || // admin shutdown, e.g. a serverless compute suspending
      /connection timeout|timeout exceeded when trying to connect|Connection terminated/i.test(message)
    ) {
      return true;
    }
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}
