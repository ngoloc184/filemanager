import { NextResponse } from "next/server";
import { loadWorkflowPayload, NO_STORE_HEADERS } from "@/lib/workflow/server";

export const dynamic = "force-dynamic";

/** A plan and its step log, for anyone with the link. */
export async function GET(_request: Request, { params }: RouteContext<"/api/workflows/[id]">) {
  const { id } = await params;
  try {
    const payload = await loadWorkflowPayload(id);
    if (!payload) return NextResponse.json({ error: "Không tìm thấy workflow" }, { status: 404, headers: NO_STORE_HEADERS });
    return NextResponse.json(payload, { headers: NO_STORE_HEADERS });
  } catch {
    return NextResponse.json({ error: "Không tải được workflow" }, { status: 500, headers: NO_STORE_HEADERS });
  }
}
