// Authentication Method Reference (`amr`) entries from the Supabase access
// token: how and when the current session was authenticated, e.g.
// [{ method: "recovery", timestamp: 1760000000 }]. Pure helpers, unit tested.

export type AmrEntry = { method: string; timestamp: number };

/** A password-reset link may set a new password for this long. */
export const RECOVERY_WINDOW_SECONDS = 60 * 60;
/**
 * Methods that prove control of the mailbox. Supabase Auth records reset
 * links as "recovery" (PKCE links) or "otp" (token_hash links / codes).
 */
export const MAILBOX_PROOF_METHODS = ["recovery", "otp", "magiclink"];
/** Adding a first password to a Google-only account needs a sign-in this recent. */
export const RECENT_SIGN_IN_SECONDS = 24 * 60 * 60;

export function parseAmr(value: unknown): AmrEntry[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is AmrEntry =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as AmrEntry).method === "string" &&
      typeof (entry as AmrEntry).timestamp === "number"
  );
}

/**
 * True when the session was authenticated within `maxAgeSeconds`, optionally
 * only counting the given methods (e.g. "recovery").
 */
export function authenticatedRecently(
  amr: AmrEntry[],
  maxAgeSeconds: number,
  methods?: string[],
  nowSeconds = Date.now() / 1000
): boolean {
  return amr.some(
    (entry) =>
      (!methods || methods.includes(entry.method)) &&
      entry.timestamp <= nowSeconds + 60 &&
      nowSeconds - entry.timestamp <= maxAgeSeconds
  );
}
