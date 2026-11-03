import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { parseDoc, parseLog, schedule, type StepLog, type WorkflowDoc } from "./model";
import { buildConfirmEmail, buildReminderEmail, confirmDigests, dueReminders, isWorkingTime, recipientsFor, reminderKind, roleKey, wallNow, type ReminderKind } from "./reminders";
import { sendMail } from "./mailer";

/** Plans are written in this zone's local time; the hourly run and "now" use it too. */
export const PLAN_TIME_ZONE = process.env.WORKFLOW_TIME_ZONE || "Asia/Ho_Chi_Minh";

type Admin = ReturnType<typeof createAdminClient>;

export interface SendResult {
  /** the step, or "_confirm" for a role's confirmation request */
  stepId: string;
  kind: ReminderKind | "confirm";
  /** the role of a confirmation request */
  roleName?: string;
  /** addresses the mail was accepted for */
  sent: number;
  /** "no-recipients": the step's roles have no addresses in the directory */
  skipped?: "no-recipients" | "already-sent" | "failed";
}

/** The link in the mail: APP_URL, else Vercel's production domain, else the caller's origin. */
export function appOrigin(requestOrigin?: string): string {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/+$/, "");
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  return requestOrigin ?? "";
}

async function loadDirectory(admin: Admin): Promise<Map<string, string[]>> {
  const { data } = await admin.from("workflow_role_contacts").select("role_name, emails");
  return new Map((data ?? []).map((r) => [roleKey(r.role_name), r.emails as string[]]));
}

async function loadExtensions(admin: Admin, ids: string[]): Promise<Map<string, StepLog[]>> {
  const out = new Map<string, StepLog[]>();
  if (!ids.length) return out;
  const { data } = await admin
    .from("workflow_step_logs")
    .select("id, workflow_id, step_id, kind, amount, unit, cancelled_at, created_at, requester_name, requester_role")
    .in("workflow_id", ids)
    .eq("kind", "extend")
    .is("cancelled_at", null);
  for (const row of data ?? []) {
    const log = parseLog(row);
    if (log) out.set(row.workflow_id, [...(out.get(row.workflow_id) ?? []), log]);
  }
  return out;
}

interface Plan {
  id: string;
  name: string;
  doc: WorkflowDoc;
  logs: StepLog[];
}

const isoDay = (minutes: number) => new Date(Math.floor(minutes / 1440) * 86_400_000).toISOString().slice(0, 10);

/** Sends one step's reminder to its PIC roles and records it under `day` (minutes; default today). */
async function sendOne(
  admin: Admin,
  plan: Plan,
  stepId: string,
  kind: ReminderKind,
  now: number,
  directory: Map<string, string[]>,
  opts: { origin: string; manual: boolean; sentBy?: { id: string; name: string }; day?: number }
): Promise<SendResult> {
  const step = plan.doc.steps.find((s) => s.id === stepId);
  const slot = schedule(plan.doc, plan.logs).get(stepId);
  if (!step || !slot) return { stepId, kind, sent: 0, skipped: "failed" };
  const to = recipientsFor(step, plan.doc, directory);
  if (!to.length) return { stepId, kind, sent: 0, skipped: "no-recipients" };

  const day = isoDay((opts.day ?? Math.floor(now / 1440)) * 1440);
  // automatic reminders: claim the (step, kind, day) slot first, so a retried run sends nothing twice
  let claimed: string | null = null;
  if (!opts.manual) {
    const { data, error } = await admin
      .from("workflow_reminders")
      .insert({ workflow_id: plan.id, step_id: stepId, kind, day, recipients: to })
      .select("id")
      .maybeSingle();
    if (error || !data) return { stepId, kind, sent: 0, skipped: "already-sent" };
    claimed = data.id;
  }

  const mail = buildReminderEmail({ workflowName: plan.name, doc: plan.doc, step, slot, kind, now, link: `${opts.origin}/workflow/${plan.id}`, sentBy: opts.sentBy?.name });
  const delivered: string[] = [];
  for (const address of to) if (await sendMail(address, mail)) delivered.push(address);

  if (!delivered.length) {
    if (claimed) await admin.from("workflow_reminders").delete().eq("id", claimed); // try again next run
    return { stepId, kind, sent: 0, skipped: "failed" };
  }
  if (claimed) await admin.from("workflow_reminders").update({ recipients: delivered }).eq("id", claimed);
  else await admin.from("workflow_reminders").insert({ workflow_id: plan.id, step_id: stepId, kind, day, manual: true, recipients: delivered, sent_by: opts.sentBy?.id ?? null });
  return { stepId, kind, sent: delivered.length };
}

const CONFIRM_STEP = "_confirm";

/** Asks one role to confirm the timeline of its unconfirmed steps; records it like a reminder. */
async function sendConfirm(
  admin: Admin,
  plan: Plan,
  roleId: string,
  now: number,
  directory: Map<string, string[]>,
  opts: { origin: string; manual: boolean; sentBy?: { id: string; name: string } }
): Promise<SendResult> {
  const role = plan.doc.roles.find((r) => r.id === roleId);
  const digest = confirmDigests(plan.doc).find((d) => d.roleId === roleId);
  const base = { stepId: CONFIRM_STEP, kind: "confirm" as const, roleName: role?.name };
  if (!role || !digest) return { ...base, sent: 0, skipped: "failed" };
  const to = directory.get(roleKey(role.name)) ?? [];
  if (!to.length) return { ...base, sent: 0, skipped: "no-recipients" };

  const day = isoDay(now);
  let claimed: string | null = null;
  if (!opts.manual) {
    const { data, error } = await admin
      .from("workflow_reminders")
      .insert({ workflow_id: plan.id, step_id: CONFIRM_STEP, kind: "confirm", day, role_name: role.name, recipients: to })
      .select("id")
      .maybeSingle();
    if (error || !data) return { ...base, sent: 0, skipped: "already-sent" };
    claimed = data.id;
  }
  const slots = schedule(plan.doc, plan.logs);
  const steps = digest.stepIds.flatMap((id) => {
    const step = plan.doc.steps.find((s) => s.id === id);
    const slot = slots.get(id);
    return step && slot ? [{ step, slot }] : [];
  });
  const mail = buildConfirmEmail({ workflowName: plan.name, doc: plan.doc, roleName: role.name, steps, link: `${opts.origin}/workflow/${plan.id}`, sentBy: opts.sentBy?.name });
  const delivered: string[] = [];
  for (const address of to) if (await sendMail(address, mail)) delivered.push(address);
  if (!delivered.length) {
    if (claimed) await admin.from("workflow_reminders").delete().eq("id", claimed);
    return { ...base, sent: 0, skipped: "failed" };
  }
  if (claimed) await admin.from("workflow_reminders").update({ recipients: delivered }).eq("id", claimed);
  else await admin.from("workflow_reminders").insert({ workflow_id: plan.id, step_id: CONFIRM_STEP, kind: "confirm", day, role_name: role.name, manual: true, recipients: delivered, sent_by: opts.sentBy?.id ?? null });
  return { ...base, sent: delivered.length };
}

async function loadPlan(admin: Admin, id: string, today: string): Promise<Plan | null> {
  const { data } = await admin.from("workflows").select("id, name, doc").eq("id", id).maybeSingle();
  const doc = data ? parseDoc(data.doc, today) : null;
  if (!data || !doc) return null;
  const logs = await loadExtensions(admin, [id]);
  return { id, name: data.name, doc, logs: logs.get(id) ?? [] };
}

/**
 * "Nhắc ngay": e-mails one step (whatever its state, unless done), every step that needs a
 * reminder today (no target), or each role its unconfirmed steps ({ confirm: true }, only the
 * roles of one step with a stepId). Admins only
 * (the route checks).
 */
export async function sendNow(
  workflowId: string,
  target: { stepId: string } | { confirm: true; stepId?: string } | null,
  sentBy: { id: string; name: string },
  origin: string
): Promise<SendResult[] | null> {
  const admin = createAdminClient();
  const now = wallNow(PLAN_TIME_ZONE);
  const plan = await loadPlan(admin, workflowId, new Date(now * 60_000).toISOString().slice(0, 10));
  if (!plan) return null;
  const directory = await loadDirectory(admin);
  if (target && "confirm" in target) {
    const results: SendResult[] = [];
    const only = target.stepId ? plan.doc.steps.find((s) => s.id === target.stepId)?.picIds ?? [] : null;
    for (const d of confirmDigests(plan.doc).filter((d) => !only || only.includes(d.roleId))) results.push(await sendConfirm(admin, plan, d.roleId, now, directory, { origin, manual: true, sentBy }));
    return results;
  }
  const stepId = target?.stepId ?? null;
  const slots = schedule(plan.doc, plan.logs);
  const targets = stepId
    ? plan.doc.steps.filter((s) => s.id === stepId).flatMap((s) => {
        const kind = reminderKind(s, slots.get(s.id), now, plan.doc.hours, true);
        return kind ? [{ stepId: s.id, kind }] : [];
      })
    : plan.doc.steps.flatMap((s) => {
        const kind = reminderKind(s, slots.get(s.id), now, plan.doc.hours);
        return kind ? [{ stepId: s.id, kind }] : [];
      });
  const results: SendResult[] = [];
  for (const t of targets) results.push(await sendOne(admin, plan, t.stepId, t.kind, now, directory, { origin, manual: true, sentBy }));
  return results;
}

/**
 * The hourly run, inside each plan's working hours: the reminders due now (see autoReminder) and,
 * once a working day, a confirmation request per role with unconfirmed steps; each at most once per
 * step (or role), kind and day, so a run repeated within the hour sends nothing twice.
 */
export async function runScheduledReminders(origin: string): Promise<{ plans: number; sent: number; skipped: number }> {
  const admin = createAdminClient();
  const now = wallNow(PLAN_TIME_ZONE);
  const today = new Date(now * 60_000).toISOString().slice(0, 10);
  const { data: rows } = await admin.from("workflows").select("id, name, doc").limit(2000);
  const plans: Plan[] = (rows ?? []).flatMap((r) => {
    const doc = parseDoc(r.doc, today);
    return doc ? [{ id: r.id, name: r.name, doc, logs: [] }] : [];
  });
  const logs = await loadExtensions(admin, plans.map((p) => p.id));
  const directory = await loadDirectory(admin);
  let sent = 0;
  let skipped = 0;
  for (const plan of plans) {
    plan.logs = logs.get(plan.id) ?? [];
    if (!isWorkingTime(now, plan.doc.hours)) continue;
    for (const t of dueReminders(plan.doc, schedule(plan.doc, plan.logs), now)) {
      const r = await sendOne(admin, plan, t.stepId, t.kind, now, directory, { origin, manual: false, day: t.day });
      sent += r.sent;
      if (r.skipped) skipped++;
    }
    for (const d of confirmDigests(plan.doc)) {
      const r = await sendConfirm(admin, plan, d.roleId, now, directory, { origin, manual: false });
      sent += r.sent;
      if (r.skipped) skipped++;
    }
  }
  return { plans: plans.length, sent, skipped };
}
