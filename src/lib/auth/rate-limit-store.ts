import "server-only";
import { createHash } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  createMemoryRateLimitStore,
  type RateLimitResult,
  type RateLimitRule,
  type RateLimitStore,
} from "@/lib/auth/rate-limit";

// Counters live in public.auth_rate_limits (migration 202608280016) so they
// are shared by every server instance. If the table or the service role key
// is missing, an in-process store keeps basic protection working.
const memoryStore = createMemoryRateLimitStore();
let warnedFallback = false;

function warnFallback(error: unknown) {
  if (warnedFallback) return;
  warnedFallback = true;
  const reason =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code: unknown }).code)
      : error instanceof Error
        ? error.message
        : "unknown";
  console.warn(`[auth] rate-limit table unavailable (${reason}); using in-memory counters.`);
}

type HitRow = { allowed: boolean; hits: number; retry_after_seconds: number };

export const rateLimitStore: RateLimitStore = {
  async hit(key: string, rule: RateLimitRule, consume: boolean): Promise<RateLimitResult> {
    try {
      const { data, error } = await createAdminClient()
        .rpc("auth_rate_limit_hit", {
          p_key: key,
          p_limit: rule.limit,
          p_window_seconds: rule.windowSeconds,
          p_consume: consume,
        })
        .single<HitRow>();
      if (error) throw error;
      return { allowed: data.allowed, retryAfterSeconds: data.retry_after_seconds };
    } catch (error) {
      warnFallback(error);
      return memoryStore.hit(key, rule, consume);
    }
  },
  async reset(key: string): Promise<void> {
    await memoryStore.reset(key);
    try {
      const { error } = await createAdminClient().rpc("auth_rate_limit_reset", { p_key: key });
      if (error) throw error;
    } catch (error) {
      warnFallback(error);
    }
  },
};

/**
 * Builds a counter key. Values (e-mail addresses, IPs) are hashed so the
 * table never stores personal data in clear text.
 */
export function rateLimitKey(scope: string, value: string): string {
  const digest = createHash("sha256").update(`fm-auth:${scope}:${value}`).digest("hex");
  return `${scope}:${digest.slice(0, 40)}`;
}
