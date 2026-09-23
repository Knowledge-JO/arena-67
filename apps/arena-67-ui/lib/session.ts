const KEY = 'arena67.session';

/**
 * Stable per-browser id that scopes every pending trade server-side.
 *
 * Wrapped in try/catch because storage throws outright in private windows and
 * with site data blocked. A session that only lives in memory still works for
 * the length of a visit, which is the whole lifetime of a trade anyway.
 */
export function getSessionId(): string {
  const fresh = () =>
    `s_${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
  try {
    const found = localStorage.getItem(KEY);
    if (found) return found;
    const made = fresh();
    localStorage.setItem(KEY, made);
    return made;
  } catch {
    return fresh();
  }
}
