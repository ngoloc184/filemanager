// Pure helpers for saved links, shared by the UI and unit tests.

export const LINK_TITLE_MAX = 200;
export const LINK_URL_MAX = 2048;

export type LinkInput = { title: string; url: string };

export type LinkValidation =
  | { ok: true; value: LinkInput }
  | { ok: false; field: "title" | "url"; message: string };

/**
 * Turns what a user typed into an absolute http(s) URL, or null when it is
 * not a web address. "example.com/x" becomes "https://example.com/x".
 */
export function normalizeUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;
  // "localhost:3000" is host:port, not a scheme, hence the (?!\d)
  const scheme = trimmed.match(/^([a-z][a-z0-9+.-]*):(?!\d)/i)?.[1];
  if (scheme && !/^https?$/i.test(scheme)) return null;
  try {
    const url = new URL(scheme ? trimmed : `https://${trimmed}`);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!url.hostname) return null;
    return url.href.length <= LINK_URL_MAX ? url.href : null;
  } catch {
    return null;
  }
}

export function validateLink(input: LinkInput): LinkValidation {
  const title = input.title.trim();
  if (!title) return { ok: false, field: "title", message: "Title is required" };
  if (title.length > LINK_TITLE_MAX) {
    return {
      ok: false,
      field: "title",
      message: `Title must be at most ${LINK_TITLE_MAX} characters`,
    };
  }
  if (!input.url.trim()) return { ok: false, field: "url", message: "URL is required" };
  const url = normalizeUrl(input.url);
  if (!url) {
    return {
      ok: false,
      field: "url",
      message: "Enter a valid web address (http:// or https://)",
    };
  }
  return { ok: true, value: { title, url } };
}

/** Short label for a URL: host plus path, without the scheme or "www.". */
export function displayUrl(href: string): string {
  try {
    const url = new URL(href);
    const host = url.hostname.replace(/^www\./, "");
    const rest = `${url.pathname === "/" ? "" : url.pathname}${url.search}${url.hash}`;
    return `${host}${url.port ? `:${url.port}` : ""}${rest}`;
  } catch {
    return href;
  }
}
