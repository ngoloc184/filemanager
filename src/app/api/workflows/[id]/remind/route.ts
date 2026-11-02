import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { isId } from "@/lib/workflow/model";
import { isMailConfigured } from "@/lib/workflow/mailer";
import { appOrigin, sendNow } from "@/lib/workflow/reminders-server";
import { isWorkflowId, NO_STORE_HEADERS } from "@/lib/workflow/server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** "Nhắc ngay" presses per plan in 10 minutes */
const MANUAL_LIMIT = 30;

function fail(error: string, status: number) {
  return NextResponse.json({ error }, { status, headers: NO_STORE_HEADERS });
}

/**
 * "Nhắc ngay": e-mails a step's PIC roles now (body { stepId }), or every step that needs a
 * reminder today (empty body). Signed-in members of the plan only.
 */
export async function POST(request: Request, { params }: RouteContext<"/api/workflows/[id]/remind">) {
  const { id } = await params;
  if (!isWorkflowId(id)) return fail("Không tìm thấy workflow", 404);
  const user = await getCurrentUser();
  if (!user) return fail("Hãy đăng nhập để gửi nhắc nhở", 401);

  const body = (await request.json().catch(() => ({}))) as { stepId?: unknown };
  const stepId = body.stepId === undefined || body.stepId === null ? null : isId(body.stepId) ? body.stepId : undefined;
  if (stepId === undefined) return fail("Dữ liệu không hợp lệ", 400);

  const supabase = await createClient();
  const [{ data: member }, { data: profile }] = await Promise.all([
    supabase.rpc("is_workflow_member", { p_workflow: id }),
    supabase.from("user_profiles").select("display_name").eq("id", user.id).maybeSingle(),
  ]);
  if (member !== true) return fail("Bạn chưa mở workflow này", 403);
  if (!isMailConfigured()) return fail("Máy chủ chưa cấu hình gửi email (SMTP). Hãy báo quản trị viên.", 503);

  try {
    const admin = createAdminClient();
    const { count } = await admin
      .from("workflow_reminders")
      .select("id", { count: "exact", head: true })
      .eq("workflow_id", id)
      .eq("manual", true)
      .gt("created_at", new Date(Date.now() - 10 * 60_000).toISOString());
    if ((count ?? 0) >= MANUAL_LIMIT) return fail("Đã gửi nhiều nhắc nhở trong ít phút, hãy thử lại sau", 429);

    const results = await sendNow(id, stepId, { id: user.id, name: profile?.display_name?.trim() || "một thành viên" }, appOrigin(new URL(request.url).origin));
    if (!results) return fail("Không tìm thấy workflow", 404);
    return NextResponse.json({ results }, { headers: NO_STORE_HEADERS });
  } catch {
    return fail("Không gửi được nhắc nhở", 500);
  }
}
