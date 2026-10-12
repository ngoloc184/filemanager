// Throttling rules for the auth endpoints, kept free of framework and
// Supabase imports so they can be unit tested. The database-backed store
// lives in rate-limit-store.ts.

export type RateLimitRule = {
  /** Attempts allowed per window. */
  limit: number;
  windowSeconds: number;
};

export type RateLimitResult = {
  allowed: boolean;
  /** Seconds until the window resets (0 when allowed). */
  retryAfterSeconds: number;
};

export interface RateLimitStore {
  /** Records an attempt (`consume`) or only inspects the current window. */
  hit(key: string, rule: RateLimitRule, consume: boolean): Promise<RateLimitResult>;
  reset(key: string): Promise<void>;
}

const MINUTE = 60;
const HOUR = 60 * MINUTE;

export const RATE_LIMITS = {
  /** Every password sign-in attempt from one IP address. */
  signInIp: { limit: 30, windowSeconds: 15 * MINUTE },
  /** Failed password attempts for one account: locks it for the window. */
  signInFailures: { limit: 5, windowSeconds: 15 * MINUTE },
  signUpIp: { limit: 10, windowSeconds: HOUR },
  /** Magic link, password reset, confirmation resend, e-mail change. */
  emailIp: { limit: 10, windowSeconds: HOUR },
  emailAddress: { limit: 5, windowSeconds: HOUR },
  /** Wrong one-time codes for one address. */
  otpFailures: { limit: 5, windowSeconds: 15 * MINUTE },
  /** Password / e-mail changes from the account page, per user. */
  accountChanges: { limit: 10, windowSeconds: 15 * MINUTE },
} satisfies Record<string, RateLimitRule>;

/** In-process fixed-window store (fallback, tests, single-instance hosts). */
export function createMemoryRateLimitStore(now: () => number = Date.now): RateLimitStore {
  const windows = new Map<string, { hits: number; start: number }>();

  function current(key: string, rule: RateLimitRule) {
    const entry = windows.get(key);
    if (!entry || now() - entry.start >= rule.windowSeconds * 1000) return null;
    return entry;
  }

  function retryAfter(start: number, rule: RateLimitRule): number {
    return Math.max(1, Math.ceil((start + rule.windowSeconds * 1000 - now()) / 1000));
  }

  return {
    async hit(key, rule, consume) {
      let entry = current(key, rule);
      if (!consume) {
        if (!entry || entry.hits < rule.limit) return { allowed: true, retryAfterSeconds: 0 };
        return { allowed: false, retryAfterSeconds: retryAfter(entry.start, rule) };
      }

      if (!entry) {
        entry = { hits: 0, start: now() };
        windows.set(key, entry);
      }
      entry.hits += 1;
      if (windows.size > 10_000) {
        for (const [k, v] of windows) {
          if (now() - v.start >= rule.windowSeconds * 1000) windows.delete(k);
        }
      }
      return entry.hits <= rule.limit
        ? { allowed: true, retryAfterSeconds: 0 }
        : { allowed: false, retryAfterSeconds: retryAfter(entry.start, rule) };
    },
    async reset(key) {
      windows.delete(key);
    },
  };
}

/**
 * Records one attempt against every key and reports the strictest outcome.
 * All keys are consumed even when an earlier one is already exhausted, so
 * hammering one dimension cannot be used to avoid counting in another.
 */
export async function consumeAll(
  store: RateLimitStore,
  checks: { key: string; rule: RateLimitRule }[]
): Promise<RateLimitResult> {
  const results = await Promise.all(
    checks.map(({ key, rule }) => store.hit(key, rule, true))
  );
  const blocked = results.filter((result) => !result.allowed);
  if (blocked.length === 0) return { allowed: true, retryAfterSeconds: 0 };
  return {
    allowed: false,
    retryAfterSeconds: Math.max(...blocked.map((result) => result.retryAfterSeconds)),
  };
}
