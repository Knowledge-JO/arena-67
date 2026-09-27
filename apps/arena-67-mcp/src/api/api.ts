import axios, { type AxiosInstance } from 'axios';
import { env } from '../config.js';

/** Must match SERVICE_HEADER in the backend's ServiceAuthGuard. */
const SERVICE_HEADER = 'x-arena-service';
/** Must match MCP_USER_HEADER in the backend's JwtAuthGuard. */
const USER_HEADER = 'x-arena-user';

/**
 * Client for the Arena 67 backend.
 *
 * Every call carries SERVICE_SECRET so the backend can tell this server apart
 * from an anonymous caller. The secret is read once at construction and never
 * logged — `toolError` deliberately reports upstream messages only, so a
 * failing request cannot echo a header back into a model's context.
 *
 * Timeout is generous because a cold token lookup can involve a full-range log
 * query to recover a PoolKey, which takes a couple of seconds — but bounded,
 * so a hung upstream surfaces as a tool error rather than a tool that never
 * returns.
 */
/**
 * @param userToken The per-turn user token the backend minted and sent us.
 *   Forwarded verbatim; this server never inspects, decodes or trusts it — the
 *   backend minted it and the backend is the only party that verifies it.
 */
function createApiClient(userToken?: string): AxiosInstance {
  const secret = env('SERVICE_SECRET');

  if (!secret) {
    console.error(
      '[arena-67-mcp] SERVICE_SECRET is unset — the backend will treat this ' +
        'server as an anonymous caller.',
    );
  }

  return axios.create({
    baseURL: env('API_URL') || 'http://localhost:9000',
    timeout: 30_000,
    headers: {
      accept: 'application/json',
      ...(secret ? { [SERVICE_HEADER]: secret } : {}),
      ...(userToken ? { [USER_HEADER]: userToken } : {}),
    },
  });
}

const axiosInstance = createApiClient();

export { axiosInstance, createApiClient, SERVICE_HEADER, USER_HEADER };
