import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createRateLimiter } from "@/lib/assistant/rate-limit";
import { createMemoryStore } from "@/lib/assistant/server";
import { defaultExpiry, detectSensitive, interpretMemory, MAX_MEMORIES, MAX_MEMORY_CHARS, type MemoryInput } from "@/lib/assistant/memory";
import { normalize } from "@/lib/assistant/text";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const allow = createRateLimiter(30, 60_000);
const MISSING = new Set(["PGRST205", "42P01"]);

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

async function session() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return { supabase, user };
}

function failure(error: unknown) {
  const code = (error as { code?: string })?.code;
  if (code && MISSING.has(code)) {
    return json({ error: "Bộ nhớ trợ lý chưa được cài đặt: cần chạy migration 202608280018.", code: "memory_not_installed" }, 503);
  }
  if ((error as { message?: string })?.message?.includes("Memory limit")) {
    return json({ error: `Bộ nhớ đã đầy (${MAX_MEMORIES} mục). Hãy xóa bớt.` }, 409);
  }
  console.error("assistant memory failed", code ?? "error");
  return json({ error: "Không thể cập nhật bộ nhớ lúc này." }, 500);
}

/** GET /api/assistant/memory — the signed-in user's memories (RLS). */
export async function GET() {
  const { supabase, user } = await session();
  if (!user) return json({ error: "Unauthorized" }, 401);
  try {
    return json({ memories: await createMemoryStore(supabase).list() });
  } catch (error) {
    return failure(error);
  }
}

/**
 * POST — remember something. Body: { text } (free text, classified like
 * "Hãy nhớ …") or { kind: "glossary", key, value } to confirm a proposal.
 */
export async function POST(request: Request) {
  const { supabase, user } = await session();
  if (!user) return json({ error: "Unauthorized" }, 401);
  if (!allow(user.id)) return json({ error: "Too many requests" }, 429);
  const body = (await request.json().catch(() => ({}))) as { text?: unknown; kind?: unknown; key?: unknown; value?: unknown };

  let item: MemoryInput;
  if (body.kind === "glossary" && typeof body.key === "string" && typeof body.value === "string") {
    const key = normalize(body.key).trim().slice(0, 60);
    const value = body.value.trim();
    if (!key || !value || value.length > MAX_MEMORY_CHARS) return json({ error: "Nội dung không hợp lệ." }, 400);
    if (detectSensitive(`${body.key} ${value}`)) return json({ error: "Tôi không lưu thông tin bảo mật." }, 400);
    item = { kind: "glossary", key, value, source: "confirmed" };
  } else if (typeof body.text === "string") {
    const result = interpretMemory(body.text);
    if ("rejected" in result) return json({ error: result.rejected }, 400);
    item = result.item;
  } else {
    return json({ error: "Nội dung không hợp lệ." }, 400);
  }

  try {
    const memory = await createMemoryStore(supabase).save({ ...item, expiresAt: defaultExpiry(item.kind) });
    return json({ memory });
  } catch (error) {
    return failure(error);
  }
}

/** PATCH — edit one memory's text: { id, value }. */
export async function PATCH(request: Request) {
  const { supabase, user } = await session();
  if (!user) return json({ error: "Unauthorized" }, 401);
  if (!allow(user.id)) return json({ error: "Too many requests" }, 429);
  const body = (await request.json().catch(() => ({}))) as { id?: unknown; value?: unknown };
  if (typeof body.id !== "string" || !UUID.test(body.id) || typeof body.value !== "string") {
    return json({ error: "Nội dung không hợp lệ." }, 400);
  }
  const value = body.value.trim();
  if (!value || value.length > MAX_MEMORY_CHARS) return json({ error: `Tối đa ${MAX_MEMORY_CHARS} ký tự.` }, 400);
  const sensitive = detectSensitive(value);
  if (sensitive) return json({ error: `Tôi không lưu ${sensitive}.` }, 400);
  try {
    const { data, error } = await supabase
      .from("assistant_memories")
      .select("kind")
      .eq("id", body.id)
      .maybeSingle();
    if (error) throw error;
    if (!data) return json({ error: "Không tìm thấy." }, 404);
    if ((data as { kind: string }).kind === "preference" && !["short", "normal", "detailed"].includes(value)) {
      return json({ error: "Giá trị không hợp lệ." }, 400);
    }
    const update = await supabase
      .from("assistant_memories")
      .update({ value, expires_at: defaultExpiry((data as { kind: "note" | "glossary" | "preference" }).kind) })
      .eq("id", body.id);
    if (update.error) throw update.error;
    return json({ ok: true });
  } catch (error) {
    return failure(error);
  }
}

/** DELETE — forget one memory ({ id }) or everything ({ all: true }). */
export async function DELETE(request: Request) {
  const { supabase, user } = await session();
  if (!user) return json({ error: "Unauthorized" }, 401);
  if (!allow(user.id)) return json({ error: "Too many requests" }, 429);
  const body = (await request.json().catch(() => ({}))) as { id?: unknown; all?: unknown };
  try {
    if (body.all === true) {
      const { error } = await supabase.from("assistant_memories").delete().eq("user_id", user.id);
      if (error) throw error;
      return json({ ok: true });
    }
    if (typeof body.id !== "string" || !UUID.test(body.id)) return json({ error: "Nội dung không hợp lệ." }, 400);
    const removed = await createMemoryStore(supabase).remove([body.id]);
    return json({ ok: removed > 0 });
  } catch (error) {
    return failure(error);
  }
}
