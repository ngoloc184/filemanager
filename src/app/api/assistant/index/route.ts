import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createIndexer } from "@/lib/assistant/indexer";
import { createRateLimiter } from "@/lib/assistant/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const NO_STORE = { "Cache-Control": "no-store" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const allow = createRateLimiter(20, 60_000);

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

/**
 * POST /api/assistant/index — extracts and indexes the text of files the
 * signed-in user can open: one file ({ fileId }) or a small batch of pending
 * files. Access is checked by the database for the user's own session.
 */
export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return json({ error: "Unauthorized" }, 401);
  if (!allow(user.id)) return json({ error: "Too many requests" }, 429);

  const indexer = createIndexer(supabase);
  if (!indexer) {
    return json({ error: "Content indexing is not configured on this server." }, 503);
  }

  let fileId: string | undefined;
  try {
    const body = (await request.json().catch(() => ({}))) as { fileId?: unknown };
    if (typeof body.fileId === "string") {
      if (!UUID.test(body.fileId)) return json({ error: "Invalid fileId" }, 400);
      fileId = body.fileId;
    }
  } catch {
    return json({ error: "Invalid request" }, 400);
  }

  try {
    const result = await indexer({ fileId, limit: fileId ? 1 : 8, budgetMs: 45_000 });
    return json(result);
  } catch (error) {
    const code = (error as { code?: string })?.code ?? "error";
    console.error("assistant indexing failed", code);
    if (["PGRST202", "PGRST205", "42883", "42P01"].includes(code)) {
      return json({ error: "Assistant migration 202608280016 has not been applied." }, 503);
    }
    return json({ error: "Indexing failed" }, 500);
  }
}
