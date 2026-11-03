// A plan as the lists show it (/workflow and "Đổi workflow"). Pure, so it runs on the server and in node:test.
import { currentStepIds, isOverdue, parseDoc, parseLog, planRange, schedule, type RoleColor, type StepLog, type WorkHours } from "./model.ts";

export interface WorkflowSummary {
  id: string;
  name: string;
  /** the viewer's membership: owner, admin, member, or null when they never opened it */
  role: string | null;
  updatedAt: string;
  clonedFrom: string | null;
  steps: number;
  done: number;
  late: number;
  extensions: number;
  extraMinutes: number;
  hours: WorkHours;
  start: number | null;
  end: number | null;
  roles: { name: string; color: RoleColor }[];
  /** the steps under way now: their number in the plan and title */
  current: { n: number; title: string }[];
}

export interface SummaryRow {
  id: string;
  name: string;
  doc: unknown;
  updated_at: string;
}

/** Summarises a plan row with its active extensions (rows of workflow_step_logs); null when not a plan. */
export function summarize(row: SummaryRow, logRows: unknown[], role: string | null, now: number, today: string): WorkflowSummary | null {
  const doc = parseDoc(row.doc, today);
  if (!doc) return null;
  const logs = logRows.map(parseLog).filter((l): l is StepLog => l !== null);
  const slots = schedule(doc, logs);
  const range = planRange(slots);
  let extra = 0;
  for (const s of slots.values()) extra += s.extraMinutes;
  const index = new Map(doc.steps.map((s, i) => [s.id, i]));
  return {
    id: row.id,
    name: row.name,
    role,
    updatedAt: row.updated_at,
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
    current: currentStepIds(doc, slots, now).map((id) => ({ n: index.get(id)! + 1, title: doc.steps[index.get(id)!].title })),
  };
}
