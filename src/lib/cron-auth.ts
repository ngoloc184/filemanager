import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";

/** SHA-256 of a value: equal-length buffers, so the length of a guess leaks nothing. */
const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();

function matchesSecret(provided: string | null, secret: string): boolean {
  if (provided === null || provided === "") return false;
  return timingSafeEqual(digest(provided), digest(secret));
}

/**
 * True when a scheduled job (Vercel Cron or another scheduler) sent the cron
 * secret: `Authorization: Bearer <secret>` (what Vercel Cron sends when
 * CRON_SECRET is set) or `x-cron-secret: <secret>`. Always false when no
 * secret is configured, so the cron routes stay closed by default. Both
 * headers are compared in constant time; nothing is logged.
 */
export function isCronAuthorized(headers: Headers, secret: string | undefined): boolean {
  if (!secret) return false;
  const authorization = headers.get("authorization");
  // evaluate both so the time taken does not tell which header matched
  const bearer = matchesSecret(authorization, `Bearer ${secret}`);
  const custom = matchesSecret(headers.get("x-cron-secret"), secret);
  return bearer || custom;
}
