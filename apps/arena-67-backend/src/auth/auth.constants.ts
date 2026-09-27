/** Cookie holding the short-lived access JWT. */
export const ACCESS_COOKIE = 'a67_at';
/** Cookie holding the rotating refresh token. Scoped to /auth. */
export const REFRESH_COOKIE = 'a67_rt';

export const ACCESS_TTL_SECONDS = 15 * 60;
export const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;

export const CODE_TTL_MS = 10 * 60 * 1000;
export const CODE_MAX_ATTEMPTS = 5;
export const CODE_LENGTH = 6;
