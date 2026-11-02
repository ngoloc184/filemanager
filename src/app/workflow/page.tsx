import type { Metadata } from "next";
import { getCurrentUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { isOverdue, nowMinutes, parseDoc, parseLog, planRange, schedule, todayDay, type StepLog } from "@/lib/workflow/model";
import { WorkflowHome, type WorkflowSummary } from "@/components/workflow/workflow-home";

export const metadata: Metadata = {
  title: "Workflow",
  description: "Vẽ quy trình, giao PIC, tính timeline từng bước và theo dõi gia hạn.",
};

/** The signed-in user's plans (those they created or opened), or how to get started. */
export default async function WorkflowListPage() {
  const user = await getCurrentUser();
  if (!user) return <WorkflowHome signedIn={false} workflows={[]} />;

  const supabase = await createClient();
  const { data: rows } = await supabase
    .from("workflow_members")
    .select("role, last_opened_at, workflows(id, name, doc, updated_at)")
    .eq("user_id", user.id)
    .order("last_opened_at", { ascending: false })
    .limit(100);
  const list = (rows ?? []).flatMap((r) => {
    const wf = Array.isArray(r.workflows) ? r.workflows[0] : r.workflows;
    return wf ? [{ role: r.role as string, wf: wf as { id: string; name: string; doc: unknown; updated_at: string } }] : [];
  });
  const { data: logRows } = list.length
    ? await supabase
        .from("workflow_step_logs")
        .select("id, workflow_id, step_id, kind, amount, unit, cancelled_at, created_at, requester_name, requester_role")
        .in("workflow_id", list.map((x) => x.wf.id))
        .eq("kind", "extend")
        .is("cancelled_at", null)
        .order("created_at", { ascending: false })
        .limit(5000)
    : { data: [] };

  const today = todayDay();
  const now = nowMinutes();
  const workflows: WorkflowSummary[] = list.flatMap(({ role, wf }) => {
    const doc = parseDoc(wf.doc, today);
    if (!doc) return [];
    const logs = (logRows ?? []).filter((l) => l.workflow_id === wf.id).map(parseLog).filter((l): l is StepLog => l !== null);
    const slots = schedule(doc, logs);
    const range = planRange(slots);
    let extra = 0;
    for (const s of slots.values()) extra += s.extraMinutes;
    return [
      {
        id: wf.id,
        name: wf.name,
        isOwner: role === "owner",
        updatedAt: wf.updated_at,
        clonedFrom: doc.clonedFrom?.name ?? null,
        steps: doc.steps.length,
        done: doc.steps.filter((s) => s.status === "done").length,
        late: doc.steps.filter((s) => isOverdue(s, slots.get(s.id), now)).length,
        extensions: logs.length,
        extraMinutes: extra,
        hours: doc.hours,
        start: range?.start ?? null,
        end: range?.end ?? null,
        roles: doc.roles.map((r) => ({ name: r.name, color: r.color })),
      },
    ];
  });

  return <WorkflowHome signedIn workflows={workflows} />;
}
