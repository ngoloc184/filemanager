import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { summarizeFile, type LlmDigest, type SummaryRpc } from "@/lib/assistant/file-summary";
import { createIndexer } from "@/lib/assistant/indexer";
import { createLlmAnswer, createLlmDigest } from "@/lib/assistant/llm";
import { createRateLimiter } from "@/lib/assistant/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const NO_STORE = { "Cache-Control": "no-store" };
const TIMEOUT_MS = 55_000;
const MISSING_SCHEMA_CODES = new Set(["PGRST202", "PGRST205", "42883", "42P01"]);
const allow = createRateLimiter(20, 60_000);

// Model output cached per file version and length (shared across users only
// after each user's own access check has passed). Bounded, per instance.
const llmCache = new Map<string, LlmDigest>();
const boundedCache = {
  get: (key: string) => llmCache.get(key),
  set: (key: string, value: LlmDigest) => {
    const oldest = llmCache.keys().next();
    if (llmCache.size >= 200 && !oldest.done) llmCache.delete(oldest.value);
    llmCache.set(key, value);
  },
};

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

/**
 * POST /api/assistant/summarize { fileId, length?, refresh?, question? }
 * Summarizes one file the signed-in user may read. Access is checked in SQL
 * with the user's own session before any content is read.
 */
export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return json({ ok: false, code: "unauthorized", message: "Bạn cần đăng nhập." }, 401);
  if (!allow(user.id)) {
    return json({ ok: false, code: "rate_limited", message: "Bạn thao tác quá nhanh, vui lòng thử lại sau ít giây." }, 429);
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, code: "invalid", message: "Yêu cầu không hợp lệ." }, 400);
  }

  const indexer = createIndexer(supabase);
  try {
    const result = await Promise.race([
      summarizeFile(body, {
        rpc: async <T,>(fn: SummaryRpc, args: Record<string, unknown>) => {
          const { data, error } = await supabase.rpc(fn, args);
          if (error) throw error;
          return (data ?? []) as T[];
        },
        indexFile: indexer
          ? async (fileId: string) => {
              await indexer({ fileId, limit: 1, budgetMs: 40_000 });
            }
          : undefined,
        llmDigest: createLlmDigest(),
        llmAnswer: createLlmAnswer(),
        cache: boundedCache,
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), TIMEOUT_MS)),
    ]);
    return json(result, result.ok ? 200 : result.status);
  } catch (error) {
    const code = (error as { code?: string })?.code;
    if (code && MISSING_SCHEMA_CODES.has(code)) {
      console.error("assistant summarize failed", code);
      return json(
        {
          ok: false,
          code: "not_installed",
          message: "Tính năng chưa được cài đặt xong: cần chạy migration 202608280016 và 202608280017 trong Supabase.",
        },
        503
      );
    }
    const timedOut = error instanceof Error && error.message === "timeout";
    console.error("assistant summarize failed", timedOut ? "timeout" : code ?? "error");
    return json(
      {
        ok: false,
        code: timedOut ? "timeout" : "error",
        message: timedOut ? "Xử lý file quá lâu, vui lòng thử lại." : "Không thể tóm tắt file lúc này, vui lòng thử lại.",
      },
      timedOut ? 504 : 500
    );
  }
}
