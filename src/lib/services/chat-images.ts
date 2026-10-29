"use client";

// Links for pictures shown inside chat messages. The files are private, so
// each picture needs a signed URL: requests made at the same moment (a whole
// conversation rendering) are combined into one database query and one
// signing call, and the links are reused for most of their lifetime so a
// re-render never reloads a picture.

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { UPLOADS_BUCKET } from "@/lib/services/files";

const TTL_SECONDS = 3600;
/** renew a little before the link expires */
const REUSE_MS = (TTL_SECONDS - 300) * 1000;

const cache = new Map<string, { url: string; until: number }>();
const waiting = new Map<string, ((url: string | null) => void)[]>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function cached(versionId: string): string | null {
  const hit = cache.get(versionId);
  return hit && hit.until > Date.now() ? hit.url : null;
}

async function flush() {
  flushTimer = null;
  const batch = new Map(waiting);
  waiting.clear();
  const ids = [...batch.keys()];
  const urls = new Map<string, string>();
  try {
    const supabase = createClient();
    const { data: versions, error } = await supabase.from("file_versions").select("id, storage_path").in("id", ids);
    if (error) throw error;
    const rows = (versions ?? []) as { id: string; storage_path: string }[];
    if (rows.length) {
      const { data: signed, error: signError } = await supabase.storage
        .from(UPLOADS_BUCKET)
        .createSignedUrls(rows.map((r) => r.storage_path), TTL_SECONDS);
      if (signError) throw signError;
      const byPath = new Map<string, string>();
      for (const s of (signed ?? []) as { path: string | null; signedUrl: string; error: string | null }[]) {
        if (s.path && s.signedUrl && !s.error) byPath.set(s.path, s.signedUrl);
      }
      const until = Date.now() + REUSE_MS;
      for (const row of rows) {
        const url = byPath.get(row.storage_path);
        if (url) {
          urls.set(row.id, url);
          cache.set(row.id, { url, until });
        }
      }
    }
  } catch {
    // shown as a normal file card instead
  }
  for (const [id, resolvers] of batch) resolvers.forEach((resolve) => resolve(urls.get(id) ?? null));
}

/** Signed URL of a file version (null when it cannot be shown). */
export function chatImageUrl(versionId: string): Promise<string | null> {
  const hit = cached(versionId);
  if (hit) return Promise.resolve(hit);
  return new Promise((resolve) => {
    waiting.set(versionId, [...(waiting.get(versionId) ?? []), resolve]);
    if (!flushTimer) flushTimer = setTimeout(() => void flush(), 25);
  });
}

/** undefined while loading, null when the picture cannot be shown. */
export function useChatImageUrl(versionId: string | null): string | null | undefined {
  const [state, setState] = useState<{ id: string | null; url: string | null | undefined }>(() => ({
    id: versionId,
    url: versionId ? cached(versionId) ?? undefined : null,
  }));
  useEffect(() => {
    if (!versionId) return;
    let cancelled = false;
    void chatImageUrl(versionId).then((url) => {
      if (!cancelled) setState({ id: versionId, url });
    });
    return () => {
      cancelled = true;
    };
  }, [versionId]);
  if (!versionId) return null;
  return state.id === versionId ? state.url : cached(versionId) ?? undefined;
}
