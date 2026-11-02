import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { isId, LIMITS } from "@/lib/workflow/model";
import { isWorkflowId, loadWorkflowPayload, NO_STORE_HEADERS } from "@/lib/workflow/server";

export const dynamic = "force-dynamic";

const MAX_BODY = 8_000;

function fail(error: string, status: number) {
  return NextResponse.json({ error }, { status, headers: NO_STORE_HEADERS });
}

const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/**
 * Extends a step ("extend") or changes its length ("duration"), for anyone with the link.
 * Both are logged on the step with the name and role the person typed; a signed-in caller is
 * recorded as such. Returns the plan as GET does.
 */
export async function POST(request: Request, { params }: RouteContext<"/api/workflows/[id]/changes">) {
  const { id } = await params;
  if (!isWorkflowId(id)) return fail("Không tìm thấy workflow", 404);

  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY) return fail("Nội dung quá dài", 413);
  const raw = await request.text();
  if (raw.length > MAX_BODY) return fail("Nội dung quá dài", 413);
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw);
  } catch {
    return fail("Dữ liệu không hợp lệ", 400);
  }
  // a hidden field people never fill: bots that fill every input are dropped quietly
  if (text(body.website, 200)) return fail("Dữ liệu không hợp lệ", 400);

  const kind = body.kind === "extend" || body.kind === "duration" ? body.kind : null;
  const amount = typeof body.amount === "number" && Number.isInteger(body.amount) ? body.amount : NaN;
  const unit = body.unit === "h" || body.unit === "d" ? body.unit : null;
  const reason = text(body.reason, LIMITS.reason);
  const name = text(body.name, LIMITS.person);
  const role = text(body.role, LIMITS.person);
  if (!kind || !isId(body.stepId) || !unit || !(amount >= 1 && amount <= LIMITS.amount)) return fail("Dữ liệu không hợp lệ", 400);
  // a signed-in caller is logged under their profile name by the database
  if (!name || !role) return fail("Hãy điền họ tên và vai trò", 400);
  if (kind === "extend" && reason.length < 3) return fail("Hãy nêu lý do gia hạn (ít nhất 3 ký tự)", 400);

  try {
    const user = await getCurrentUser();
    const { error } = await createAdminClient().rpc("workflow_public_change", {
      p_workflow: id,
      p_step: body.stepId,
      p_kind: kind,
      p_amount: amount,
      p_unit: unit,
      p_reason: reason || null,
      p_name: name,
      p_role: role,
      p_user: user?.id ?? null,
    });
    if (error) {
      if (error.code === "PT404") return fail("Không tìm thấy bước này, có thể nó vừa bị xoá", 404);
      if (error.code === "PT429") return fail("Có quá nhiều yêu cầu, hãy thử lại sau ít phút", 429);
      return fail("Không lưu được thay đổi", 400);
    }
    const payload = await loadWorkflowPayload(id);
    return payload ? NextResponse.json(payload, { headers: NO_STORE_HEADERS }) : fail("Không tìm thấy workflow", 404);
  } catch {
    return fail("Không lưu được thay đổi", 500);
  }
}
