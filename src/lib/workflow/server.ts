import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

// Anyone with a plan's link may view it, signed in or not, so plans are read with the service
// role here and never with the visitor's own client. Only what the page shows leaves the server:
// no owner or user ids.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isWorkflowId(value: string): boolean {
  return UUID_RE.test(value);
}

/** What /api/workflows/[id] returns; the client validates `doc` and `logs` with parseDoc/parseLog. */
export interface WorkflowPayload {
  id: string;
  name: string;
  revision: number;
  updatedAt: string;
  doc: unknown;
  logs: Record<string, unknown>[];
}

const LOG_LIMIT = 3000;

export const NO_STORE_HEADERS = { "Cache-Control": "private, no-store" };

export async function loadWorkflowPayload(id: string): Promise<WorkflowPayload | null> {
  if (!isWorkflowId(id)) return null;
  const db = createAdminClient();
  const [{ data: wf, error }, { data: logs }] = await Promise.all([
    db.from("workflows").select("id, name, doc, revision, updated_at").eq("id", id).maybeSingle(),
    db
      .from("workflow_step_logs")
      .select("id, step_id, kind, amount, unit, old_amount, old_unit, reason, requester_name, requester_role, created_by, created_at, cancelled_at")
      .eq("workflow_id", id)
      // newest first, so a flood of requests can never hide the latest ones
      .order("created_at", { ascending: false })
      .limit(LOG_LIMIT),
  ]);
  if (error || !wf) return null;
  return {
    id: wf.id,
    name: wf.name,
    revision: wf.revision,
    updatedAt: wf.updated_at,
    doc: wf.doc,
    logs: (logs ?? []).reverse().map(({ created_by, ...row }) => ({ ...row, signed_in: created_by !== null })),
  };
}
