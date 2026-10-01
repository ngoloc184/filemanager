// Response headers for files served at /superapp/<name>. Framework-free so
// they can be unit tested with `node --test`.

const CONTENT_TYPE_BY_EXTENSION: Record<string, string> = {
  ".json": "application/json",
  ".bundle": "application/javascript",
};

/** Versioned URLs (`?v=x.y.z`) never change, so they are cached for a year. */
export const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";
export const SHORT_CACHE_CONTROL =
  "public, max-age=0, s-maxage=60, stale-while-revalidate=86400";

export function contentTypeFor(name: string, storedMimeType: string): string {
  const dot = name.lastIndexOf(".");
  const extension = dot >= 0 ? name.slice(dot).toLowerCase() : "";
  return (
    CONTENT_TYPE_BY_EXTENSION[extension] ??
    (storedMimeType || "application/octet-stream")
  );
}

export function cacheHeadersFor(url: URL): Record<string, string> {
  if (url.searchParams.get("v")) {
    return {
      "Cache-Control": IMMUTABLE_CACHE_CONTROL,
      // Vercel's CDN only caches on s-maxage/CDN headers; this Vercel-only
      // header (stripped before reaching the client) lets the edge keep
      // versioned files for a year too.
      "Vercel-CDN-Cache-Control": "max-age=31536000",
    };
  }
  return { "Cache-Control": SHORT_CACHE_CONTROL };
}
