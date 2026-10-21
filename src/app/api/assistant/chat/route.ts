import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { answer, type AssistantRpc } from "@/lib/assistant/engine";
import { MAX_QUESTION_LENGTH } from "@/lib/assistant/intent";
import { createIndexer } from "@/lib/assistant/indexer";
import { createLlmGroundedAnswer, createLlmSummarizer } from "@/lib/assistant/llm";
import { createRateLimiter } from "@/lib/assistant/rate-limit";
import { actionsConfigured, openContext, sealContext, signAction } from "@/lib/assistant/action-token";
import { createMemoryStore, dailyTokenBudget, loadTuning, logEvent, optional, tokensUsedToday } from "@/lib/assistant/server";
import { parseMemoryCommand } from "@/lib/assistant/memory";
import { sanitizeContext, type ConversationContext } from "@/lib/assistant/context";
import type { AssistantReply } from "@/lib/assistant/types";
import { agentTurn, agentWaitsForChoice, createLessonStore, signAgentAction } from "@/lib/agent";
import { parseForget, parseTeaching } from "@ai-pro/agent-core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const NO_STORE = { "Cache-Control": "no-store" };
const ANSWER_TIMEOUT_MS = 25_000;
/** PostgREST / Postgres codes for "function or table does not exist". */
const MISSING_SCHEMA_CODES = new Set(["PGRST202", "PGRST205", "42883", "42P01"]);
const allow = createRateLimiter(30, 60_000);

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

/**
 * POST /api/assistant/chat — the assistant's chat. Messages go to the agent
 * (src/lib/agent, built on packages/agent-core), which runs file-manager
 * tools and hands everything else to the assistant engine. The user is taken
 * from the session cookie; every query runs with the user's own database
 * permissions (no service role, no free-form SQL). The conversation context
 * (engine context + agent state) is signed per user; ids in it are
 * re-checked anyway, and an unsigned agent state is discarded.
 */
export async function POST(request: Request) {
  const started = Date.now();
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return json({ error: "Bạn cần đăng nhập để dùng trợ lý." }, 401);

  if (!allow(user.id)) {
    return json({ error: "Bạn đang hỏi quá nhanh, vui lòng thử lại sau ít giây." }, 429);
  }

  let body: { message?: unknown; page?: unknown; contextFileId?: unknown; context?: unknown };
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
  const opened = openContext(user.id, body.context);
  if (JSON.stringify(opened.context ?? null).length > 8000) return json({ error: "Yêu cầu không hợp lệ." }, 400);

  const rpc = async <T,>(fn: AssistantRpc, args: Record<string, unknown>): Promise<T[]> => {
    const { data, error } = await supabase.rpc(fn, args);
    if (error) throw error;
    return (data ?? []) as T[];
  };

  // The optional model is used only while the user's daily budget lasts.
  const summarizeWithLlm = createLlmSummarizer();
  const answerWithLlm = createLlmGroundedAnswer();
  const withinBudget = summarizeWithLlm || answerWithLlm ? (await tokensUsedToday(supabase)) < dailyTokenBudget() : false;
  const [tuning, memoryReady] = await Promise.all([
    loadTuning(supabase),
    optional(async () => !(await supabase.from("assistant_memories").select("id").limit(1)).error, false),
  ]);

  const deps = {
    rpc,
    indexPending: createIndexer(supabase),
    summarizeWithLlm: withinBudget ? summarizeWithLlm : undefined,
    answerWithLlm: withinBudget ? answerWithLlm : undefined,
    memory: memoryReady ? createMemoryStore(supabase) : undefined,
    findFolders: async (name: string) => {
      const { data } = await supabase
        .from("folders")
        .select("id, name")
        .is("deleted_at", null)
        .ilike("name", `%${name.replace(/[%_\\]/g, (c) => `\\${c}`).slice(0, 100)}%`)
        .limit(10);
      return (data ?? []) as { id: string; name: string }[];
    },
    signAction: actionsConfigured() ? (spec: Parameters<typeof signAction>[1]) => signAction(user.id, spec) : undefined,
    tuning,
    contextTrusted: opened.trusted,
  };
  const rawContext = (opened.context ?? undefined) as Record<string, unknown> | undefined;
  // The agent's pending questions are only trusted when the context was signed
  // by us. Without a signing key nothing can be signed (and no write can be
  // confirmed): accept the sanitized state so choices still work; ids in it
  // are re-checked by row-level security when used.
  const agentState = opened.trusted || !actionsConfigured() ? rawContext?.agent : undefined;
  const engineFirst =
    page > 1 || (parseMemoryCommand(message) !== null && !parseTeaching(message) && !parseForget(message));

  const run = async (): Promise<{ result: AssistantReply; context: object | undefined }> => {
    if (engineFirst) {
      const result = await answer({ message, page, contextFileId, context: opened.context }, deps);
      return { result, context: result.context ? { ...result.context, agent: agentState } : undefined };
    }
    const choice = agentWaitsForChoice(agentState) ? contextFileId : null;
    let engineFileId = choice ? null : contextFileId;
    const { reply, context } = await agentTurn({
      message,
      choice,
      context: rawContext ? sanitizeContext(rawContext) : sanitizeContext({}),
      agentState,
      ctx: {
        supabase,
        userId: user.id,
        index: async (fileId: string) => {
          await createIndexer(supabase)?.({ fileId, limit: 1, budgetMs: 5000 });
        },
      },
      lessons: createLessonStore(supabase, user.id),
      runEngine: (text: string, ctx: ConversationContext) => {
        // a file picked in the UI applies to the first engine call of this turn
        const fileId = engineFileId;
        engineFileId = null;
        return answer({ message: text, page: 1, contextFileId: fileId, context: ctx }, deps);
      },
      sign: actionsConfigured() ? (tool, params) => signAgentAction(user.id, tool, params) : undefined,
      tuningVersion: tuning.version,
    });
    return { result: reply, context };
  };

  try {
    const { result, context } = await Promise.race([
      run(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), ANSWER_TIMEOUT_MS)),
    ]);
    const replyId = await logEvent(supabase, { intent: result.intent, meta: result.meta, latencyMs: Date.now() - started });
    return json({ ...result, replyId, context: context ? sealContext(user.id, context) : undefined });
  } catch (error) {
    const code = (error as { code?: string })?.code;
    // Function or table missing: an assistant migration has not been applied.
    if (code && MISSING_SCHEMA_CODES.has(code)) {
      console.error("assistant chat failed", code);
      return json(
        {
          error:
            "Trợ lý chưa được cài đặt xong trên máy chủ: cần chạy các migration 202608280016, 202608280017 và 202608280018 (thư mục supabase/migrations) trong Supabase SQL Editor.",
          code: "assistant_not_installed",
        },
        503
      );
    }
    const timedOut = error instanceof Error && error.message === "timeout";
    // Log the failure type only, never the question or file data.
    console.error("assistant chat failed", timedOut ? "timeout" : (error as { code?: string })?.code ?? "error");
    await logEvent(supabase, { intent: "error", latencyMs: Date.now() - started, errorCode: timedOut ? "timeout" : (code ?? "error") });
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
