import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { listWorkflowSummaries, NO_STORE_HEADERS } from "@/lib/workflow/server";

export const dynamic = "force-dynamic";

/** GET /api/workflows — every plan in the system, summarised, for "Đổi workflow". Signed-in users only. */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Hãy đăng nhập để xem danh sách workflow" }, { status: 401, headers: NO_STORE_HEADERS });
  try {
    const { all } = await listWorkflowSummaries(user.id);
    return NextResponse.json({ workflows: all }, { headers: NO_STORE_HEADERS });
  } catch {
    return NextResponse.json({ error: "Không tải được danh sách workflow" }, { status: 500, headers: NO_STORE_HEADERS });
  }
}
