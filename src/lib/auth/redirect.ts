// Post-login destinations come from the URL (`?next=`), so they must be
// restricted to same-site paths to prevent open redirects.

export const DEFAULT_AFTER_LOGIN = "/dashboard";

const BASE = "http://same-origin.invalid";

/** Pages that make no sense as a post-login destination. */
const NON_DESTINATIONS = [
  "/login",
  "/register",
  "/forgot-password",
  "/magic-link",
  "/auth/",
  "/api/",
];

/**
 * Returns `raw` when it is a same-origin path (e.g. `/dashboard?folder=1`),
 * otherwise `fallback`. Rejects absolute URLs, protocol-relative URLs (`//x`),
 * backslash tricks (`/\x`) and control characters.
 */
export function safeNextPath(raw: unknown, fallback = DEFAULT_AFTER_LOGIN): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048) {
    return fallback;
  }
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) {
    return fallback;
  }
  if (/[\u0000-\u001f\u007f]/.test(raw)) return fallback;

  let url: URL;
  try {
    url = new URL(raw, BASE);
  } catch {
    return fallback;
  }
  if (url.origin !== BASE) return fallback;

  const path = url.pathname;
  if (
    NON_DESTINATIONS.some((prefix) =>
      prefix.endsWith("/") ? path.startsWith(prefix) : path === prefix || path.startsWith(`${prefix}/`)
    )
  ) {
    return fallback;
  }
  return `${path}${url.search}${url.hash}`;
}
