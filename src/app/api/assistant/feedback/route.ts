import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createRateLimiter } from "@/lib/assistant/rate-limit";
import { analyzeQuestion } from "@/lib/assistant/retrieval";
import { detectSensitive } from "@/lib/assistant/memory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REASONS = new Set(["wrong", "not_found", "irrelevant", "missing_source", "incomplete", "other"]);
const allow = createRateLimiter(20, 60_000);

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

/**
 * POST /api/assistant/feedback — 👍/👎 on one answer.
 * Body: { replyId, rating: 1|-1, reason?, correction?, question?, citedFiles? }.
 * Only keywords of the question are stored (never the question itself); a
 * correction that looks like a secret is refused. Feedback is reviewed by an
 * administrator before it changes anything shared (see docs/ai-assistant.md).
 */
export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return json({ error: "Unauthorized" }, 401);
  if (!allow(user.id)) return json({ error: "Too many requests" }, 429);

  const body = (await request.json().catch(() => ({}))) as {
    replyId?: unknown;
    rating?: unknown;
    reason?: unknown;
    correction?: unknown;
    question?: unknown;
    citedFiles?: unknown;
    /** lessons the agent used for this answer (👍 confirms, 👎 rejects them) */
    lessons?: unknown;
  };
  if (typeof body.replyId !== "string" || !UUID.test(body.replyId) || (body.rating !== 1 && body.rating !== -1)) {
    return json({ error: "Phản hồi không hợp lệ." }, 400);
  }
  const reason = typeof body.reason === "string" && REASONS.has(body.reason) ? body.reason : null;
  let correction = typeof body.correction === "string" ? body.correction.trim().slice(0, 500) : "";
  if (correction && detectSensitive(correction)) {
    return json({ error: "Phần góp ý có vẻ chứa thông tin bảo mật nên không được lưu. Hãy bỏ thông tin đó và gửi lại." }, 400);
  }
  correction = correction || "";
  const terms = typeof body.question === "string" ? analyzeQuestion(body.question.slice(0, 500)).terms.slice(0, 12) : [];
  const cited = Array.isArray(body.citedFiles) ? body.citedFiles.filter((x): x is string => typeof x === "string" && UUID.test(x)).slice(0, 10) : [];

  const lessons = Array.isArray(body.lessons) ? body.lessons.filter((x): x is string => typeof x === "string" && UUID.test(x)).slice(0, 10) : [];
  // votes count only once the reply is known to be the caller's own (RLS on
  // assistant_feedback); best effort: learning must never block feedback
  const voteLessons = async () => {
    if (lessons.length) await supabase.rpc("agent_vote", { p_ids: lessons, p_vote: body.rating }).then(() => undefined, () => undefined);
  };

  const row = { rating: body.rating, reason, correction: correction || null };
  const insert = await supabase
    .from("assistant_feedback")
    .insert({ event_id: body.replyId, ...row, query_terms: terms, cited_files: cited });
  if (insert.error?.code === "23505") {
    const update = await supabase.from("assistant_feedback").update(row).eq("event_id", body.replyId).select("event_id");
    if (update.error) return json({ error: "Không lưu được phản hồi." }, 500);
    if ((update.data ?? []).length) await voteLessons();
    return json({ ok: true, updated: true });
  }
  if (insert.error) {
    const code = insert.error.code;
    if (code === "PGRST205" || code === "42P01") {
      return json({ error: "Chức năng phản hồi chưa được cài đặt (cần migration 202608280018).", code: "feedback_not_installed" }, 503);
    }
    // RLS: not the user's own answer, or unknown id
    return json({ error: "Không lưu được phản hồi." }, code === "42501" ? 403 : 400);
  }
  await voteLessons();
  return json({ ok: true });
}
