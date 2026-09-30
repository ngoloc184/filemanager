// Storage helpers shared by client services and server route handlers.

export const UPLOADS_BUCKET = "uploads";

export const DEFAULT_MIME_TYPE = "application/octet-stream";

/** Supabase Storage accepts at most this many paths per `remove` call. */
export const STORAGE_REMOVE_BATCH_SIZE = 100;

export function sanitizeStorageName(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 180);
  return cleaned || "file";
}

/** Object key layout: `<owner>/<file>/<version>/<sanitized name>`. */
export function buildStoragePath(
  userId: string,
  fileId: string,
  versionId: string,
  fileName: string
): string {
  return `${userId}/${fileId}/${versionId}/${sanitizeStorageName(fileName)}`;
}
