import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { wallNow } from "./reminders";
import { PLAN_TIME_ZONE } from "./reminders-server";
import { summarize, type SummaryRow, type WorkflowSummary } from "./summary";

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

const LIST_LIMIT = 500;

/**
 * Every plan (newest change first) and the signed-in user's own (last opened first), summarised.
 * Read with the service role: any signed-in user may list every plan; the caller checks sign-in.
 */
export async function listWorkflowSummaries(userId: string): Promise<{ mine: WorkflowSummary[]; all: WorkflowSummary[] }> {
  const db = createAdminClient();
  const now = wallNow(PLAN_TIME_ZONE);
  const today = new Date(now * 60_000).toISOString().slice(0, 10);
  const [{ data: rows }, { data: members }] = await Promise.all([
    db.from("workflows").select("id, name, doc, updated_at").order("updated_at", { ascending: false }).limit(LIST_LIMIT),
    db.from("workflow_members").select("workflow_id, role").eq("user_id", userId).order("last_opened_at", { ascending: false }).limit(100),
  ]);
  const plans = new Map((rows ?? []).map((r) => [r.id as string, r as SummaryRow]));
  const missing = (members ?? []).map((m) => m.workflow_id as string).filter((id) => !plans.has(id));
  if (missing.length) {
    const { data: more } = await db.from("workflows").select("id, name, doc, updated_at").in("id", missing);
    for (const r of more ?? []) plans.set(r.id, r as SummaryRow);
  }
  const { data: logRows } = plans.size
    ? await db
        .from("workflow_step_logs")
        .select("id, workflow_id, step_id, kind, amount, unit, cancelled_at, created_at, requester_name, requester_role")
        .in("workflow_id", [...plans.keys()])
        .eq("kind", "extend")
        .is("cancelled_at", null)
        .limit(10_000)
    : { data: [] };
  const logsOf = new Map<string, unknown[]>();
  for (const l of logRows ?? []) logsOf.set(l.workflow_id, [...(logsOf.get(l.workflow_id) ?? []), l]);
  const roleOf = new Map((members ?? []).map((m) => [m.workflow_id as string, m.role as string]));

  const summaries = new Map<string, WorkflowSummary>();
  for (const [id, row] of plans) {
    const s = summarize(row, logsOf.get(id) ?? [], roleOf.get(id) ?? null, now, today);
    if (s) summaries.set(id, s);
  }
  return {
    mine: (members ?? []).flatMap((m) => summaries.get(m.workflow_id) ?? []),
    all: (rows ?? []).flatMap((r) => summaries.get(r.id) ?? []),
  };
}
