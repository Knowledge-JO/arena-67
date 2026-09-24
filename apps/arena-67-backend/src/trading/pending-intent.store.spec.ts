import { PendingIntentStore } from './pending-intent.store';
import { INTENT_TTL_MS, QUOTE_TTL_MS } from './pending-intent.store';
import type { TradeIntent } from '../openserv/schemas';

const SESSION = 'session-a';
const OTHER_SESSION = 'session-b';

function intent(overrides: Partial<TradeIntent> = {}): TradeIntent {
  return { action: 'buy', ticker: 'ANIME', ...overrides };
}

function quote(id = 'quote-1') {
  return {
    id,
    amountIn: 100n,
    amountOut: 99n,
    minAmountOut: 98n,
    priceImpactBps: 0,
    feeTier: 500,
    tickSpacing: 10,
    hooks: '0x0000000000000000000000000000000000000000' as `0x${string}`,
    quotedAt: Date.now(),
  };
}

describe('PendingIntentStore', () => {
  let store: PendingIntentStore;

  beforeEach(() => {
    store = new PendingIntentStore();
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-24T00:00:00Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('creates a collecting intent owned by the session', () => {
    const created = store.create(SESSION, intent());
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.sessionId).toBe(SESSION);
    expect(created.status).toBe('collecting');
  });

  it('rejects reads from a different session', () => {
    const created = store.create(SESSION, intent());
    expect(() => store.get(created.id, OTHER_SESSION)).toThrow(
      'no longer available',
    );
  });

  it('marks intents expired past INTENT_TTL', () => {
    const created = store.create(SESSION, intent());
    jest.advanceTimersByTime(INTENT_TTL_MS + 1);
    expect(() => store.get(created.id, SESSION)).toThrow('expired');
  });

  it('resolve a picked candidate by opaque id, clearing the rest', () => {
    const created = store.create(SESSION, intent());
    store.patch(created.id, SESSION, {
      candidates: [
        {
          id: 'c-1',
          address: '0x1111111111111111111111111111111111111111',
          symbol: 'ANIME',
          name: 'Anime One',
          decimals: 18,
          liquidityUsd: 0,
          warnings: [],
        },
        {
          id: 'c-2',
          address: '0x2222222222222222222222222222222222222222',
          symbol: 'ANIME',
          name: 'Anime Two',
          decimals: 18,
          liquidityUsd: 0,
          warnings: [],
        },
      ],
    });

    const picked = store.selectCandidate(created.id, SESSION, 'c-2');
    expect(picked.token?.address).toBe(
      '0x2222222222222222222222222222222222222222',
    );
    expect(picked.candidates).toBeUndefined();
  });

  it('rejects a candidate id that was never offered', () => {
    const created = store.create(SESSION, intent());
    expect(() => store.selectCandidate(created.id, SESSION, 'c-999')).toThrow(
      'not one of the options',
    );
  });

  it('claims a fresh quoted intent exactly once', () => {
    const created = store.create(SESSION, intent());
    store.patch(created.id, SESSION, { token: undefined, amount: 5 });
    store.patch(created.id, SESSION, {
      status: 'quoted',
      quote: quote(),
      funding: {
        address: '0x0000000000000000000000000000000000000000',
        symbol: 'ETH',
        decimals: 18,
      },
    });

    expect(store.claimForExecution(created.id, SESSION, 'quote-1')).toBe(true);
    expect(store.get(created.id, SESSION).status).toBe('executing');
    // Repeated confirm - the double-click hazard - is a no-op, never a second spend.
    expect(store.claimForExecution(created.id, SESSION, 'quote-1')).toBe(false);
  });

  it('refuses a claim for a different quote id than the one shown', () => {
    const created = store.create(SESSION, intent());
    store.patch(created.id, SESSION, { token: undefined, amount: 5 });
    store.patch(created.id, SESSION, {
      status: 'quoted',
      quote: quote('quote-1'),
    });

    expect(() =>
      store.claimForExecution(created.id, SESSION, 'quote-2'),
    ).toThrow('out of date');
  });

  it('refuses a claim once the quote has gone stale', () => {
    const created = store.create(SESSION, intent());
    store.patch(created.id, SESSION, { token: undefined, amount: 5 });
    store.patch(created.id, SESSION, {
      status: 'quoted',
      quote: quote('quote-1'),
    });
    jest.advanceTimersByTime(QUOTE_TTL_MS + 1);

    expect(() =>
      store.claimForExecution(created.id, SESSION, 'quote-1'),
    ).toThrow('out of date');
  });

  it('never claims an intent that is not quoted', () => {
    const created = store.create(SESSION, intent());
    expect(store.claimForExecution(created.id, SESSION, 'quote-1')).toBe(false);
  });

  it('activeFor returns the most recently updated still-open intent', () => {
    const a = store.create(SESSION, intent());
    const b = store.create(SESSION, intent());
    store.patch(b.id, SESSION, { amount: 5 });
    jest.advanceTimersByTime(1_000);
    const c = store.create(SESSION, intent());

    expect(store.activeFor(SESSION)?.id).toBe(c.id);
    expect(store.activeFor(OTHER_SESSION)).toBeUndefined();
    expect(store.activeFor(SESSION)?.id).not.toBe(a.id);
  });

  it('sweep drops expired intents and keeps an in-flight execution', () => {
    const expired = store.create(SESSION, intent());
    const inFlight = store.create(SESSION, intent());
    store.patch(inFlight.id, SESSION, { status: 'executing' });

    jest.advanceTimersByTime(INTENT_TTL_MS + 1);
    store.sweep();

    const map = (
      store as unknown as { intents: Map<string, { status: string }> }
    ).intents;
    expect(map.has(expired.id)).toBe(false);
    expect(map.get(inFlight.id)?.status).toBe('executing');
  });
});
