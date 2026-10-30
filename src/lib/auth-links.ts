// Pure helpers for sign-up confirmation and password reset by e-mail link
// (unit-tested). Supabase e-mails a link; it lands on /auth/confirm, which
// signs the user in and continues to `next`.

export const PASSWORD_MIN = 6;
/** Seconds before "Resend e-mail" is available again. */
export const RESEND_COOLDOWN = 60;

export type AuthFlow = "signup" | "recovery";

/** Where each flow continues after the link signed the user in. */
export const FLOW_NEXT: Record<AuthFlow, string> = {
  signup: "/dashboard",
  recovery: "/forgot-password?step=password",
};

/**
 * The redirect URL given to Supabase (must be in the project's Redirect URLs).
 * A safe `next` (e.g. an invitation link) replaces the sign-up destination;
 * a password reset always continues to the new-password step.
 */
export function confirmRedirect(origin: string, flow: AuthFlow, next?: string | null): string {
  const url = new URL("/auth/confirm", origin);
  url.searchParams.set("flow", flow);
  const custom = flow === "signup" ? safeNext(next, "") : "";
  url.searchParams.set("next", custom || FLOW_NEXT[flow]);
  return url.toString();
}

/**
 * The page to return to after signing in, from "?next=" (set by the
 * middleware when it sent a signed-out visitor to /login). Null when it is
 * missing or not a same-site path.
 */
export function nextFromSearch(search: URLSearchParams | null): string | null {
  return safeNext(search?.get("next"), "") || null;
}

/** `href` with "?next=" kept, so /login ↔ /register links do not lose it. */
export function withNext(href: string, next: string | null): string {
  if (!next) return href;
  return `${href}${href.includes("?") ? "&" : "?"}next=${encodeURIComponent(next)}`;
}

export function passwordProblem(password: string, confirm: string): string | null {
  if (password.length < PASSWORD_MIN) return `Password must be at least ${PASSWORD_MIN} characters.`;
  if (password !== confirm) return "Passwords do not match.";
  return null;
}

/**
 * Only same-site paths are allowed after confirming ("/dashboard",
 * "/forgot-password?step=password"); anything else falls back, so the
 * confirm link cannot redirect to another site. The value is parsed the way
 * the browser will parse it: URL parsers drop tabs and line breaks, so
 * "/\t/evil.com" would otherwise become "//evil.com", and dot segments
 * collapse ("/..//evil.com" → "//evil.com"), so the result is checked too.
 */
export function safeNext(next: string | null | undefined, fallback = "/dashboard"): string {
  const unsafe = (path: string) => !path.startsWith("/") || path.startsWith("//") || /[\u0000-\u001f\u007f\\]/.test(path);
  if (!next || unsafe(next)) return fallback;
  try {
    const base = "https://same-site.invalid";
    const url = new URL(next, base);
    const out = `${url.pathname}${url.search}${url.hash}`;
    return url.origin !== base || unsafe(out) ? fallback : out;
  } catch {
    return fallback;
  }
}

/**
 * The origin the browser used. Behind a proxy (or opened by IP) Next's
 * `request.nextUrl.origin` is the server's own address ("http://localhost:3000"),
 * so the forwarded / Host headers are preferred.
 */
export function requestOrigin(headers: Headers, fallback: string): string {
  const host = (headers.get("x-forwarded-host") ?? headers.get("host"))?.split(",")[0].trim();
  if (!host || !/^[a-z0-9.\-]+(:\d+)?$|^\[[0-9a-f:.]+\](:\d+)?$/i.test(host)) return fallback;
  const forwarded = headers.get("x-forwarded-proto")?.split(",")[0].trim();
  const proto = forwarded === "http" || forwarded === "https" ? forwarded : new URL(fallback).protocol.slice(0, -1);
  return `${proto}://${host}`;
}

/**
 * A form post from this site (login-CSRF check). Browsers send `Origin` on
 * POST; when a proxy or extension strips it, `Sec-Fetch-Site` still tells.
 * Neither header can be set by another site.
 */
export function isSameOriginPost(headers: Headers, expectedOrigin: string): boolean {
  if (headers.get("origin") === expectedOrigin) return true;
  return headers.get("sec-fetch-site") === "same-origin";
}

/** What /auth/confirm tells the next page when a link did not sign the user in. */
export type ConfirmOutcome = "confirmed" | "expired" | "other-browser" | "invalid";

/**
 * Decides the outcome of a failed confirmation.
 * - Supabase reported an error (e.g. otp_expired)            → expired / invalid
 * - a sign-up `code` could not be exchanged: Supabase already
 *   confirmed the address before redirecting, but the link was
 *   opened in another browser than the one that signed up      → confirmed
 * - a password-reset `code` from another browser             → other-browser
 */
export function failedOutcome(input: { flow: AuthFlow | null; hadCode: boolean; errorCode: string | null }): ConfirmOutcome {
  if (input.errorCode) return /expired/.test(input.errorCode) ? "expired" : "invalid";
  if (input.hadCode) return input.flow === "recovery" ? "other-browser" : "confirmed";
  return "invalid";
}

export const OUTCOME_MESSAGE: Record<ConfirmOutcome, string> = {
  confirmed: "Your e-mail is confirmed. Please sign in.",
  // Supabase answers "otp_expired" for used links too
  expired: "This link has expired or was already used. Request a new e-mail.",
  "other-browser": "Open the reset link in the same browser where you requested it, or request a new e-mail here.",
  invalid: "This link is invalid or was already used. Request a new e-mail.",
};

/** The message for a flow: a used sign-up link usually means "already confirmed". */
export function outcomeMessage(outcome: ConfirmOutcome, flow: AuthFlow): string {
  if (flow === "signup" && (outcome === "invalid" || outcome === "expired")) {
    return outcome === "expired"
      ? "This confirmation link has expired or was already used. If you already confirmed your e-mail, just sign in; otherwise sign in to get a new link."
      : "This confirmation link was already used or is invalid. If you already confirmed your e-mail, just sign in; otherwise sign in to get a new link.";
  }
  return OUTCOME_MESSAGE[outcome];
}

/**
 * Where a failed link sends the user: /forgot-password for resets, else /login.
 * A sign-up link keeps a safe `next` (e.g. an invitation opened in another
 * browser), so signing in there still continues to it.
 */
export function failurePath(flow: AuthFlow | null, outcome: ConfirmOutcome, next?: string | null): string {
  const page = flow === "recovery" ? "/forgot-password" : "/login";
  const path = `${page}?${outcome === "confirmed" ? "notice" : "error"}=${outcome}`;
  const keep = flow === "recovery" ? "" : safeNext(next, "");
  return keep && keep !== FLOW_NEXT.signup ? withNext(path, keep) : path;
}

/** The flow of a link: the app's `flow` parameter, else the token type. */
export function flowOf(flowParam: string | null, type: string | null): AuthFlow | null {
  if (flowParam === "signup" || flowParam === "recovery") return flowParam;
  if (type === "recovery") return "recovery";
  return type ? "signup" : null;
}

/** Turns Supabase Auth errors into messages users can act on. */
export function authErrorMessage(error: unknown): string {
  const message = (error as { message?: string } | null)?.message ?? "";
  const code = (error as { code?: string } | null)?.code ?? "";
  if (/over_email_send_rate_limit|rate limit|too many/i.test(code + message)) {
    return "Too many e-mails were sent. Please wait a few minutes and try again.";
  }
  if (/email_address_not_authorized|not authorized/i.test(code + message)) {
    return "E-mails can't be sent to this address yet: the server's e-mail service is not configured. Contact the administrator.";
  }
  if (/email_not_confirmed|not confirmed/i.test(code + message)) {
    return "Your e-mail is not confirmed yet. Click the link in the e-mail we sent you.";
  }
  if (/user_already_exists|already registered/i.test(code + message)) {
    return "This e-mail is already registered. Sign in, or reset your password.";
  }
  if (/weak_password|password should/i.test(code + message)) {
    return message || "This password is too weak.";
  }
  if (/same_password|different from the old/i.test(code + message)) {
    return "Choose a password different from your current one.";
  }
  if (/session|not authenticated|jwt/i.test(message)) {
    return "Your reset link has expired. Request a new e-mail.";
  }
  if (/invalid login credentials/i.test(message)) return "Wrong e-mail or password.";
  return message || "Something went wrong. Please try again.";
}
