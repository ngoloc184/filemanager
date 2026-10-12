import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { UPLOADS_BUCKET } from "@/lib/storage";
import { extractText } from "@/lib/assistant/extract";
import { INDEXABLE_EXTENSIONS, MAX_INDEX_BYTES } from "@/lib/assistant/formats";
import type { IndexResult } from "@/lib/assistant/engine";

type Candidate = {
  file_id: string;
  version_id: string;
  storage_path: string;
  name: string;
  extension: string;
  mime_type: string;
  size: number | string;
};

const EXTRACT_TIMEOUT_MS = 15_000;
const CANDIDATE_WINDOW = 20;

export function isIndexingConfigured(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
  ]);
}

async function indexOne(user: SupabaseClient, candidate: Candidate): Promise<void> {
  let status: "indexed" | "empty" | "unsupported" | "too_large" | "failed" = "failed";
  let content = "";
  let truncated = false;
  let error: string | null = null;

  if (Number(candidate.size) > MAX_INDEX_BYTES) {
    status = "too_large";
  } else {
    // Downloaded with the *user's* session: storage policies re-check access.
    const { data, error: downloadError } = await user.storage
      .from(UPLOADS_BUCKET)
      .download(candidate.storage_path);
    if (downloadError || !data) {
      error = "download_failed";
    } else if (data.size > MAX_INDEX_BYTES) {
      status = "too_large";
    } else {
      try {
        const bytes = new Uint8Array(await data.arrayBuffer());
        const result = await withTimeout(extractText(candidate.extension, bytes), EXTRACT_TIMEOUT_MS);
        status = result.status;
        if (result.status === "indexed") {
          content = result.text;
          truncated = result.truncated;
        } else if (result.status === "empty" && result.reason) {
          error = result.reason;
        }
      } catch {
        error = "extract_failed";
      }
    }
  }

  // Only the server may write the index (users have no write privileges).
  const { error: writeError } = await createAdminClient()
    .from("file_contents")
    .upsert({
      file_id: candidate.file_id,
      version_id: candidate.version_id,
      status,
      content,
      char_count: content.length,
      truncated,
      error,
      indexed_at: new Date().toISOString(),
    });
  if (writeError) throw writeError;
}

/**
 * Returns a function that indexes files the signed-in user can open, or
 * undefined when the server is not configured for indexing.
 */
export function createIndexer(user: SupabaseClient) {
  if (!isIndexingConfigured()) return undefined;

  return async ({
    fileId,
    limit,
    budgetMs,
  }: {
    fileId?: string;
    limit: number;
    budgetMs: number;
  }): Promise<IndexResult> => {
    const deadline = Date.now() + budgetMs;
    const { data, error } = await user.rpc("assistant_index_candidates", {
      p_extensions: INDEXABLE_EXTENSIONS,
      p_file_id: fileId ?? null,
      p_limit: fileId ? 1 : CANDIDATE_WINDOW,
    });
    if (error) throw error;
    const candidates = (data ?? []) as Candidate[];

    let indexed = 0;
    for (const candidate of candidates.slice(0, limit)) {
      if (Date.now() > deadline) break;
      await indexOne(user, candidate);
      indexed += 1;
    }
    return { indexed, remaining: Math.max(candidates.length - indexed, 0) };
  };
}
