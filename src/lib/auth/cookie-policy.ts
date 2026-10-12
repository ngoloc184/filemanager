// Attributes for the Supabase session cookies (`sb-<ref>-auth-token*`).
//
// The browser never reads these cookies: data requests get a short-lived
// access token from GET /api/auth/token instead (see lib/supabase/client.ts),
// so the long-lived refresh token can stay HttpOnly.

/** Present with value "0" when the user un-ticked "Remember me". */
export const REMEMBER_COOKIE = "fm-remember";

/** "Remember me" keeps the session for 30 days of inactivity (sliding). */
export const REMEMBER_ME_MAX_AGE = 60 * 60 * 24 * 30;

export type CookieOptions = {
  path?: string;
  domain?: string;
  maxAge?: number;
  expires?: Date;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: boolean | "lax" | "strict" | "none";
  priority?: "low" | "medium" | "high";
  partitioned?: boolean;
};

/** Secure cookies everywhere except `next dev` on plain http. */
export function secureCookies(): boolean {
  return process.env.NODE_ENV === "production";
}

/** Sessions persist unless the user explicitly chose a browser-session login. */
export function isPersistentSession(rememberCookieValue: string | undefined): boolean {
  return rememberCookieValue !== "0";
}

/**
 * Hardens the options Supabase passes for an auth cookie:
 * HttpOnly, SameSite=Lax (needed for OAuth / e-mail link redirects), Secure in
 * production, and either a 30-day lifetime or a browser-session cookie.
 * Deletions (max-age 0) keep their max-age.
 */
export function authCookieOptions(
  options: CookieOptions | undefined,
  { persistent, secure }: { persistent: boolean; secure: boolean }
): CookieOptions {
  const result: CookieOptions = {
    ...options,
    path: options?.path ?? "/",
    httpOnly: true,
    sameSite: "lax",
    secure,
  };
  if (options?.maxAge === 0) return result;

  delete result.expires;
  if (persistent) {
    result.maxAge = REMEMBER_ME_MAX_AGE;
  } else {
    delete result.maxAge;
  }
  return result;
}

/** Options for the remember-me marker itself (always a session cookie). */
export function rememberCookieOptions(secure: boolean): CookieOptions {
  return { path: "/", httpOnly: true, sameSite: "lax", secure };
}
