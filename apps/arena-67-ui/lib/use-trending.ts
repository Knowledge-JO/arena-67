'use client';

import { useEffect, useState } from 'react';
import { api } from './api';
import type { TrendingSnapshot } from './types';

const POLL_MS = 30_000;

/**
 * Live market data for the landing page. Polls the desk's research endpoint
 * and reports failure honestly: when the backend is down the landing shows an
 * offline state rather than invented tokens.
 */
export function useTrending(): { snap: TrendingSnapshot | null; failed: boolean } {
  const [snap, setSnap] = useState<TrendingSnapshot | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const s = await api.trending();
        if (alive) {
          setSnap(s);
          setFailed(false);
        }
      } catch {
        if (alive) setFailed(true);
      }
    };
    void load();
    const t = setInterval(load, POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  return { snap, failed };
}
