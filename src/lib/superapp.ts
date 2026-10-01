import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";

/** Public files are addressed by name: letters, digits, ".", "_" and "-". */
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

/** Storage prefixes for SuperApp files; kept apart from per-user folders. */
const STORAGE_PREFIX = "superapp";
const VERSIONED_STORAGE_PREFIX = "superapp-v";

export function isValidSuperAppName(name: string): boolean {
  return NAME_PATTERN.test(name);
}

/**
 * Object key of a published file: `superapp-v/<version>/<name>` for a
 * versioned snapshot, `superapp/<name>` for an unversioned (legacy) upload.
 */
export function superAppStoragePath(
  name: string,
  version: string | null = null
): string {
  return version
    ? `${VERSIONED_STORAGE_PREFIX}/${version}/${name}`
    : `${STORAGE_PREFIX}/${name}`;
}

/**
 * Checks the `Authorization: Bearer <key>` (or `X-API-Key`) header against
 * SUPERAPP_API_KEY using a constant-time comparison.
 * Returns false when the key is not configured, so the API stays closed.
 */
export function isAuthorizedSuperAppRequest(request: Request): boolean {
  const expected = process.env.SUPERAPP_API_KEY;
  if (!expected) return false;

  const authorization = request.headers.get("authorization") ?? "";
  const provided = authorization.toLowerCase().startsWith("bearer ")
    ? authorization.slice(7).trim()
    : (request.headers.get("x-api-key") ?? "").trim();
  if (!provided) return false;

  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(provided), digest(expected));
}
