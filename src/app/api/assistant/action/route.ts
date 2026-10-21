import { createHash, randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createRateLimiter } from "@/lib/assistant/rate-limit";
import { verifyAction } from "@/lib/assistant/action-token";
import { buildExport, EXPORT_MIME, exportFileName } from "@/lib/assistant/export";
import { buildExportDocument } from "@/lib/assistant/export-builder";
import { createIndexer } from "@/lib/assistant/indexer";
import { logEvent } from "@/lib/assistant/server";
import { openUrl } from "@/lib/assistant/engine";
import { UPLOADS_BUCKET, buildStoragePath } from "@/lib/storage";
import type { ActionResult, ActionSpec } from "@/lib/assistant/actions";
import { AGENT_TOKEN_PREFIX, fileAgent, verifyAgentAction } from "@/lib/agent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const NO_STORE = { "Cache-Control": "no-store" };
const allow = createRateLimiter(10, 60_000);
/** Confirmed tokens on this instance (blocks double submits). */
const used = new Map<string, number>();

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

function friendly(error: unknown): string {
  const message = (error as { message?: string })?.message ?? "";
  if (/quota/i.test(message)) return "Không đủ dung lượng lưu trữ.";
  if (/permission|not allowed|denied|access/i.test(message) || (error as { code?: string })?.code === "42501") {
    return "Bạn không có quyền thực hiện thao tác này.";
  }
  if (/already exists|duplicate|unique/i.test(message)) return "Đã có mục cùng tên ở vị trí này.";
  if (/not found|no rows/i.test(message)) return "Không tìm thấy file hoặc thư mục (có thể đã bị xóa hoặc bạn không còn quyền).";
  if (/user not found|grantee/i.test(message)) return "Không tìm thấy người dùng với e-mail này.";
  return "Không thực hiện được thao tác.";
}

/**
 * POST /api/assistant/action — executes an action the user confirmed in the
 * chat. Body: { token }. The token is signed for this user and expires after
 * 10 minutes; the work runs with the user's own permissions (RLS + the
 * existing security-definer functions), never with the service role.
 */
export async function POST(request: Request) {
  const started = Date.now();
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return json({ ok: false, message: "Bạn cần đăng nhập." }, 401);
  if (!allow(user.id)) return json({ ok: false, message: "Thao tác quá nhanh, vui lòng thử lại sau." }, 429);

  const body = (await request.json().catch(() => ({}))) as { token?: unknown };
  const token = typeof body.token === "string" ? body.token : "";
  if (token.startsWith(AGENT_TOKEN_PREFIX)) return runAgentAction(token, supabase, user.id, started);
  const verified = verifyAction(token, user.id);
  if (!verified.ok) {
    return json(
      { ok: false, message: verified.reason === "expired" ? "Yêu cầu đã hết hạn, hãy hỏi lại trợ lý." : "Yêu cầu không hợp lệ." },
      verified.reason === "user" ? 403 : 400
    );
  }
  const now = Date.now();
  for (const [nonce, at] of used) if (now - at > 15 * 60_000) used.delete(nonce);
  if (used.has(verified.nonce)) return json({ ok: false, message: "Thao tác này đã được thực hiện." }, 409);
  used.set(verified.nonce, now);

  let result: ActionResult;
  try {
    result = await execute(verified.spec, supabase, user.id);
  } catch (error) {
    used.delete(verified.nonce);
    result = { ok: false, message: friendly(error) };
  }
  await logEvent(supabase, {
    intent: `do:${verified.spec.kind}`.slice(0, 40),
    latencyMs: Date.now() - started,
    errorCode: result.ok ? null : "action_failed",
  });
  return json(result, result.ok ? 200 : 400);
}

type Supabase = Awaited<ReturnType<typeof createClient>>;

/** Confirmed agent tool: same checks as assistant actions, executed by the tool. */
async function runAgentAction(token: string, supabase: Supabase, userId: string, started: number) {
  const verified = verifyAgentAction(token, userId);
  if (!verified.ok) {
    return json(
      { ok: false, message: verified.reason === "expired" ? "Yêu cầu đã hết hạn, hãy hỏi lại trợ lý." : "Yêu cầu không hợp lệ." },
      verified.reason === "user" ? 403 : 400
    );
  }
  const now = Date.now();
  for (const [nonce, at] of used) if (now - at > 15 * 60_000) used.delete(nonce);
  if (used.has(verified.nonce)) return json({ ok: false, message: "Thao tác này đã được thực hiện." }, 409);
  used.set(verified.nonce, now);

  let result: ActionResult;
  try {
    const done = await fileAgent.execute(verified.tool, verified.params, {
      supabase,
      userId,
      index: async (fileId: string) => {
        await createIndexer(supabase)?.({ fileId, limit: 1, budgetMs: 8000 });
      },
      engine: async () => {
        throw new Error("not available while executing");
      },
    });
    result = done.ok ? { ok: true, message: done.message, openUrl: done.openUrl } : { ok: false, message: done.message };
    if (!done.ok) used.delete(verified.nonce);
  } catch (error) {
    used.delete(verified.nonce);
    result = { ok: false, message: friendly(error) };
  }
  await logEvent(supabase, {
    intent: `do:agent:${verified.tool}`.slice(0, 40),
    latencyMs: Date.now() - started,
    errorCode: result.ok ? null : "action_failed",
  });
  return json(result, result.ok ? 200 : 400);
}

async function execute(spec: ActionSpec, supabase: Supabase, userId: string): Promise<ActionResult> {
  switch (spec.kind) {
    case "create_folder": {
      const { data, error } = await supabase
        .rpc("create_folder", { p_parent_id: spec.parentId, p_name: spec.name, p_comment: null })
        .select()
        .single();
      if (error) throw error;
      const id = (data as { id: string }).id;
      return { ok: true, message: `Đã tạo thư mục “${spec.name}”.`, folderId: id, openUrl: `/dashboard?folder=${id}` };
    }
    case "rename_file": {
      const { error } = await supabase.rpc("rename_file", { p_id: spec.fileId, p_name: spec.name });
      if (error) throw error;
      return { ok: true, message: `Đã đổi tên thành “${spec.name}”.`, fileId: spec.fileId, openUrl: openUrl(spec.fileId, null) };
    }
    case "move_file": {
      const { error } = await supabase.rpc("move_file", { p_id: spec.fileId, p_folder_id: spec.folderId });
      if (error) throw error;
      return { ok: true, message: "Đã di chuyển file.", fileId: spec.fileId, openUrl: openUrl(spec.fileId, spec.folderId) };
    }
    case "share_file": {
      const { error } = await supabase.rpc("share_file", { p_file_id: spec.fileId, p_grantee_email: spec.email, p_role: spec.role });
      if (error) throw error;
      return { ok: true, message: `Đã chia sẻ với ${spec.email} (${spec.role === "editor" ? "chỉnh sửa" : "chỉ xem"}).`, fileId: spec.fileId };
    }
    case "create_export": {
      const rpc = async <T,>(fn: string, args: Record<string, unknown>): Promise<T[]> => {
        const { data, error } = await supabase.rpc(fn, args);
        if (error) throw error;
        return (data ?? []) as T[];
      };
      const doc = await buildExportDocument(spec.title, spec.source, rpc);
      if (!doc) return { ok: false, message: "Không còn dữ liệu để xuất (file có thể đã bị xóa hoặc bạn không còn quyền xem)." };
      const bytes = buildExport(doc, spec.format);
      const name = exportFileName(spec.title, spec.format);
      const fileId = randomUUID();
      const versionId = randomUUID();
      const path = buildStoragePath(userId, fileId, versionId, name);
      const upload = await supabase.storage
        .from(UPLOADS_BUCKET)
        .upload(path, bytes, { contentType: EXPORT_MIME[spec.format], upsert: false });
      if (upload.error) throw upload.error;
      const registered = await supabase.rpc("register_file", {
        p_id: fileId,
        p_folder_id: null,
        p_name: name,
        p_original_name: name,
        p_extension: spec.format,
        p_mime_type: EXPORT_MIME[spec.format],
        p_size: bytes.byteLength,
        p_storage_path: path,
        p_checksum: createHash("sha256").update(bytes).digest("hex"),
        p_version_id: versionId,
      });
      if (registered.error) {
        await supabase.storage.from(UPLOADS_BUCKET).remove([path]);
        throw registered.error;
      }
      // make the new file searchable right away (best effort)
      await createIndexer(supabase)?.({ fileId, limit: 1, budgetMs: 8000 }).catch(() => undefined);
      return { ok: true, message: `Đã tạo file “${name}” trong thư mục gốc.`, fileId, openUrl: openUrl(fileId, null) };
    }
  }
}
