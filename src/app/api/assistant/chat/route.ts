import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { answer, type AssistantRpc } from "@/lib/assistant/engine";
import { MAX_QUESTION_LENGTH } from "@/lib/assistant/intent";
import { createIndexer } from "@/lib/assistant/indexer";
import { createLlmSummarizer } from "@/lib/assistant/llm";
import { createRateLimiter } from "@/lib/assistant/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const NO_STORE = { "Cache-Control": "no-store" };
const ANSWER_TIMEOUT_MS = 25_000;
const allow = createRateLimiter(30, 60_000);

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

/**
 * POST /api/assistant/chat — answers a question about the signed-in user's
 * files. The user is taken from the session cookie; every query runs with the
 * user's own database permissions (no service role, no free-form SQL).
 */
export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return json({ error: "Bạn cần đăng nhập để dùng trợ lý." }, 401);

  if (!allow(user.id)) {
    return json({ error: "Bạn đang hỏi quá nhanh, vui lòng thử lại sau ít giây." }, 429);
  }

  let body: { message?: unknown; page?: unknown; contextFileId?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ error: "Yêu cầu không hợp lệ." }, 400);
  }

  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) return json({ error: "Vui lòng nhập câu hỏi." }, 400);
  if (message.length > MAX_QUESTION_LENGTH) {
    return json({ error: `Câu hỏi tối đa ${MAX_QUESTION_LENGTH} ký tự.` }, 400);
  }
  const page = typeof body.page === "number" && Number.isFinite(body.page) ? body.page : 1;
  const contextFileId = typeof body.contextFileId === "string" ? body.contextFileId : null;

  const rpc = async <T,>(fn: AssistantRpc, args: Record<string, unknown>): Promise<T[]> => {
    const { data, error } = await supabase.rpc(fn, args);
    if (error) throw error;
    return (data ?? []) as T[];
  };

  try {
    const result = await Promise.race([
      answer(
        { message, page, contextFileId },
        {
          rpc,
          indexPending: createIndexer(supabase),
          summarizeWithLlm: createLlmSummarizer(),
        }
      ),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), ANSWER_TIMEOUT_MS)),
    ]);
    return json(result);
  } catch (error) {
    const timedOut = error instanceof Error && error.message === "timeout";
    // Log the failure type only, never the question or file data.
    console.error("assistant chat failed", timedOut ? "timeout" : (error as { code?: string })?.code ?? "error");
    return json(
      {
        error: timedOut
          ? "Truy vấn mất quá nhiều thời gian. Hãy thử thu hẹp câu hỏi."
          : "Không thể xử lý câu hỏi lúc này. Vui lòng thử lại sau.",
      },
      timedOut ? 504 : 500
    );
  }
}
