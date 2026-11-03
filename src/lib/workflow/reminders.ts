// Which steps get a reminder e-mail, and the e-mail itself. Pure functions (tested with node:test);
// the server side that loads plans and sends mail is src/lib/workflow/reminders-server.ts.
import { dayMark, minutesPerDay, normalizeStart, workBetween, type Slot, type WorkHours, type WorkflowDoc, type WorkflowStep } from "./model.ts";

/**
 * upcoming: starts on the next working day · start: starts today (or this hour) · due: ends today
 * (or within the hour) · overdue · progress: running (sent by hand)
 */
export type ReminderKind = "upcoming" | "start" | "due" | "overdue" | "progress";

/** Steps whose timeline is not confirmed yet, grouped by PIC role (done steps need nothing). */
export function confirmDigests(doc: WorkflowDoc): { roleId: string; roleName: string; stepIds: string[] }[] {
  return doc.roles.flatMap((role) => {
    const stepIds = doc.steps.filter((s) => s.status !== "done" && s.confirmed === null && s.picIds.includes(role.id)).map((s) => s.id);
    return stepIds.length ? [{ roleId: role.id, roleName: role.name, stepIds }] : [];
  });
}

const DAY = 1440;
const HOUR = 60;

/** The plan's wall-clock time now in a time zone (the plans are written in local time). */
export function wallNow(timeZone: string, date = new Date()): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
      .formatToParts(date)
      .map((p) => [p.type, p.value])
  );
  return Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute) / 60_000;
}

export function isWorkday(day: number, hours: WorkHours): boolean {
  const w = new Date(day * DAY * 60_000).getUTCDay();
  return !(hours.skipWeekends && (w === 0 || w === 6));
}

/** Inside the plan's working hours (not before, after, at lunch or on a day off). */
export function isWorkingTime(t: number, hours: WorkHours): boolean {
  return normalizeStart(t, hours) === t;
}

/**
 * The reminder a step needs today, for the "Nhắc việc" list and "Nhắc ngay" (done steps never get
 * one). By hand (`manual`) every unfinished step gets one: upcoming before its start, else progress.
 */
export function reminderKind(step: WorkflowStep, slot: Slot | undefined, now: number, hours: WorkHours, manual = false): ReminderKind | null {
  if (!slot || step.status === "done") return null;
  const today = Math.floor(now / DAY);
  if (slot.end < now) return "overdue";
  if (Math.floor(slot.end / DAY) === today) return "due";
  if (Math.floor(slot.start / DAY) === today) return "start";
  // the next working day: tomorrow, or Monday when today is Friday
  const nextWorkday = Math.floor(normalizeStart((today + 1) * DAY, hours) / DAY);
  const startDay = Math.floor(slot.start / DAY);
  if (step.status === "todo" && slot.start > now && startDay > today && startDay <= nextWorkday) return "upcoming";
  if (!manual) return null;
  return slot.start > now ? "upcoming" : "progress";
}

/**
 * The automatic reminder of a step at `now` (the job runs every hour), with the plan day it is
 * recorded under so each one goes out once:
 * - a step in days: on the day it starts, and on its due day when it lasts more than one day;
 * - a step in hours: in the hour it starts, and in its last hour before the deadline;
 * - overdue and not done: once a working day.
 */
export function autoReminder(step: WorkflowStep, slot: Slot | undefined, now: number, hours: WorkHours): { kind: ReminderKind; day: number } | null {
  if (!slot || step.status === "done") return null;
  const today = Math.floor(now / DAY);
  if (slot.end < now) return { kind: "overdue", day: today };
  if (slot.start > now) return null;
  const startDay = Math.floor(slot.start / DAY);
  const endDay = Math.floor(slot.end / DAY);
  if (step.duration.unit === "h") {
    if (workBetween(slot.start, now, hours) < HOUR) return { kind: "start", day: startDay };
    if (workBetween(now, slot.end, hours) <= HOUR) return { kind: "due", day: endDay };
    return null;
  }
  if (startDay === today) return { kind: "start", day: startDay };
  const longerThanADay = slot.baseMinutes + slot.extraMinutes > minutesPerDay(hours);
  if (endDay === today && longerThanADay) return { kind: "due", day: endDay };
  return null;
}

/** The automatic reminders of a plan at `now`: none outside its working hours. */
export function dueReminders(doc: WorkflowDoc, slots: Map<string, Slot>, now: number): { stepId: string; kind: ReminderKind; day: number }[] {
  if (!isWorkingTime(now, doc.hours)) return [];
  return doc.steps.flatMap((s) => {
    const r = autoReminder(s, slots.get(s.id), now, doc.hours);
    return r ? [{ stepId: s.id, ...r }] : [];
  });
}

/** Addresses for a step's PIC roles, looked up by role name (case and outer spaces ignored). */
export function recipientsFor(step: WorkflowStep, doc: WorkflowDoc, directory: Map<string, string[]>): string[] {
  const out = new Set<string>();
  for (const id of step.picIds) {
    const role = doc.roles.find((r) => r.id === id);
    for (const e of (role && directory.get(roleKey(role.name))) ?? []) out.add(e);
  }
  return [...out];
}

export function roleKey(name: string): string {
  return name.trim().toLowerCase();
}

// ---------------------------------------------------------------- the e-mail

const WEEKDAYS = ["Chủ nhật", "Thứ hai", "Thứ ba", "Thứ tư", "Thứ năm", "Thứ sáu", "Thứ bảy"];

/** "Thứ năm, 12/11/2026 lúc 08:00" */
export function longMoment(t: number): string {
  const d = new Date(t * 60_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${WEEKDAYS[d.getUTCDay()]}, ${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} lúc ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** Working minutes as "1 ngày 4 giờ". */
function minutesText(minutes: number, hours: WorkHours): string {
  const perDay = minutesPerDay(hours);
  const days = Math.floor(minutes / perDay);
  const rest = Math.round(((minutes - days * perDay) / 60) * 10) / 10;
  return [days ? `${days} ngày` : "", rest ? `${String(rest).replace(".", ",")} giờ` : ""].filter(Boolean).join(" ") || "dưới 1 giờ";
}

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export interface ReminderEmailInput {
  workflowName: string;
  doc: WorkflowDoc;
  step: WorkflowStep;
  slot: Slot;
  kind: ReminderKind;
  now: number;
  link: string;
  /** who pressed "Nhắc ngay" (manual reminders only) */
  sentBy?: string;
}

/** A courteous Vietnamese reminder: subject, plain text and HTML. */
export function buildReminderEmail(input: ReminderEmailInput): { subject: string; text: string; html: string } {
  const { workflowName, doc, step, slot, kind, now, link, sentBy } = input;
  const index = doc.steps.indexOf(step) + 1;
  const title = step.title.trim() || "(chưa đặt tên)";
  const roles = step.picIds.map((id) => doc.roles.find((r) => r.id === id)?.name).filter((n): n is string => !!n);
  const team = roles.length ? roles.join(", ") : "phụ trách";
  const length = `${step.duration.amount} ${step.duration.unit === "d" ? "ngày" : "giờ"}` + (slot.extraMinutes > 0 ? ` + gia hạn ${minutesText(slot.extraMinutes, doc.hours)}` : "");
  // how late, in working time
  const late = kind === "overdue" ? minutesText(workBetween(slot.end, now, doc.hours), doc.hours) : "";
  const endsToday = Math.floor(slot.end / DAY) === Math.floor(now / DAY);

  const lead: Record<ReminderKind, string> = {
    upcoming: `Hệ thống Workflow trân trọng thông báo: công việc dưới đây do nhóm ${team} phụ trách sẽ bắt đầu vào ${longMoment(slot.start)}, với thời gian thực hiện dự kiến là ${length}.`,
    start:
      slot.start > now
        ? `Hệ thống Workflow trân trọng thông báo: công việc dưới đây do nhóm ${team} phụ trách sẽ bắt đầu vào ${longMoment(slot.start)} hôm nay, với thời gian thực hiện dự kiến là ${length} và hạn hoàn thành là ${longMoment(slot.end)}.`
        : `Hệ thống Workflow trân trọng thông báo: đã đến thời gian bắt đầu công việc dưới đây do nhóm ${team} phụ trách (từ ${longMoment(slot.start)}), với thời gian thực hiện dự kiến là ${length} và hạn hoàn thành là ${longMoment(slot.end)}.`,
    due: `Hệ thống Workflow trân trọng nhắc: công việc dưới đây do nhóm ${team} phụ trách sẽ đến hạn hoàn thành vào ${longMoment(slot.end)}${endsToday ? " hôm nay" : ""} và hiện chưa được đánh dấu hoàn thành.`,
    overdue: `Hệ thống Workflow trân trọng thông báo: công việc dưới đây do nhóm ${team} phụ trách đã quá hạn hoàn thành (${longMoment(slot.end)}) và hiện chưa được đánh dấu hoàn thành.`,
    progress: `Hệ thống Workflow trân trọng nhắc: công việc dưới đây do nhóm ${team} phụ trách đang trong thời gian thực hiện, với hạn hoàn thành là ${longMoment(slot.end)}.`,
  };
  const ask: Record<ReminderKind, string> = {
    upcoming: "Kính mong Quý Anh/Chị sắp xếp thời gian để bắt đầu đúng kế hoạch.",
    start: "Kính mong Quý Anh/Chị bắt đầu thực hiện đúng kế hoạch và cập nhật trạng thái trên trang workflow. Nếu cần thêm thời gian, Quý Anh/Chị vui lòng gia hạn trên trang và nêu rõ lý do.",
    due: "Nếu công việc đã hoàn thành, kính đề nghị Quý Anh/Chị cập nhật trạng thái trên trang workflow. Nếu cần thêm thời gian, Quý Anh/Chị vui lòng gia hạn trực tiếp trên trang và nêu rõ lý do.",
    overdue: "Kính đề nghị Quý Anh/Chị khẩn trương hoàn tất và cập nhật trạng thái, hoặc gia hạn trên trang workflow kèm lý do, để các bước tiếp theo được điều chỉnh kịp thời.",
    progress: "Kính mong Quý Anh/Chị theo dõi để hoàn thành đúng hạn. Nếu cần thêm thời gian, Quý Anh/Chị vui lòng gia hạn trên trang workflow và nêu rõ lý do.",
  };
  const label: Record<ReminderKind, string> = {
    upcoming: "Sắp bắt đầu",
    start: "Bắt đầu công việc",
    due: endsToday ? "Sắp đến hạn hôm nay" : "Sắp đến hạn",
    overdue: late ? `Trễ hạn ${late}` : "Trễ hạn",
    progress: "Đang thực hiện",
  };
  const subject = `[Nhắc việc] ${label[kind]}: Bước ${index} – ${title.length > 80 ? `${title.slice(0, 77)}…` : title}`;
  const rows: [string, string][] = [
    ["Quy trình", workflowName],
    [`Bước ${index}`, title],
    ["Người phụ trách (PIC)", roles.join(", ") || "—"],
    ["Thời lượng", length],
    ["Bắt đầu", `${longMoment(slot.start)} (T+${String(dayMark(doc, slot.start)).replace(".", ",")})`],
    ["Hạn hoàn thành", `${longMoment(slot.end)} (T+${String(dayMark(doc, slot.end)).replace(".", ",")})`],
  ];
  if (step.note.trim()) rows.push(["Ghi chú", step.note.trim()]);
  const by = sentBy ? `Lời nhắc này được gửi theo yêu cầu của ${sentBy}.` : "";
  const greeting = `Kính gửi Quý Anh/Chị thuộc nhóm ${team},`;
  const footer = "Đây là email tự động từ hệ thống Workflow, vui lòng không trả lời email này.";

  const text = [
    greeting,
    "",
    lead[kind],
    "",
    ...rows.map(([k, v]) => `• ${k}: ${v}`),
    "",
    ask[kind],
    `Xem chi tiết: ${link}`,
    ...(by ? ["", by] : []),
    "",
    "Trân trọng cảm ơn sự phối hợp của Quý Anh/Chị.",
    "",
    "Trân trọng,",
    "Hệ thống Workflow",
    "",
    `— ${footer}`,
  ].join("\n");

  const accent = kind === "overdue" ? "#e11d48" : kind === "due" ? "#d97706" : kind === "start" ? "#0284c7" : "#6d28d9";
  const html = `<!doctype html><html lang="vi"><body style="margin:0;background:#f4f4f7;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1f2937">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f7;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb">
<tr><td style="background:${accent};color:#ffffff;padding:14px 24px;font-size:13px;font-weight:600;letter-spacing:.02em">${escape(label[kind].toUpperCase())}</td></tr>
<tr><td style="padding:24px">
<p style="margin:0 0 12px;font-size:15px">${escape(greeting)}</p>
<p style="margin:0 0 16px;font-size:15px;line-height:1.6">${escape(lead[kind])}</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:14px;margin:0 0 16px">
${rows.map(([k, v]) => `<tr><td style="padding:8px 12px;background:#f9fafb;border:1px solid #e5e7eb;width:38%;color:#6b7280;vertical-align:top">${escape(k)}</td><td style="padding:8px 12px;border:1px solid #e5e7eb;font-weight:500;white-space:pre-wrap">${escape(v)}</td></tr>`).join("\n")}
</table>
<p style="margin:0 0 20px;font-size:15px;line-height:1.6">${escape(ask[kind])}</p>
<p style="margin:0 0 20px"><a href="${escape(link)}" style="display:inline-block;background:${accent};color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:8px;font-size:14px;font-weight:600">Mở workflow</a></p>
${by ? `<p style="margin:0 0 16px;font-size:13px;color:#6b7280">${escape(by)}</p>` : ""}
<p style="margin:0;font-size:15px;line-height:1.6">Trân trọng cảm ơn sự phối hợp của Quý Anh/Chị.<br><br>Trân trọng,<br><strong>Hệ thống Workflow</strong></p>
</td></tr>
<tr><td style="padding:14px 24px;background:#f9fafb;border-top:1px solid #e5e7eb;font-size:12px;color:#9ca3af">${escape(footer)}</td></tr>
</table></td></tr></table></body></html>`;

  return { subject, text, html };
}

/** The e-mail asking one role to check and confirm the timeline of its steps (one per role). */
export function buildConfirmEmail(input: {
  workflowName: string;
  doc: WorkflowDoc;
  roleName: string;
  steps: { step: WorkflowStep; slot: Slot }[];
  link: string;
  sentBy?: string;
}): { subject: string; text: string; html: string } {
  const { workflowName, doc, roleName, steps, link, sentBy } = input;
  const subject = `[Xác nhận timeline] ${workflowName}: ${steps.length} bước của nhóm ${roleName} cần xác nhận`;
  const greeting = `Kính gửi Quý Anh/Chị thuộc nhóm ${roleName},`;
  const lead = `Hệ thống Workflow trân trọng đề nghị Quý Anh/Chị kiểm tra và xác nhận thời gian thực hiện của ${steps.length} bước dưới đây trong quy trình “${workflowName}”. Thời gian hiện tại là giá trị mặc định và chưa được nhóm xác nhận.`;
  const ask =
    "Kính đề nghị Quý Anh/Chị mở workflow, điều chỉnh số ngày/giờ nếu cần, rồi bấm “Xác nhận” ở từng bước. Sau khi xác nhận, thời gian của bước được chốt và chỉ có thể thay đổi bằng hình thức gia hạn kèm lý do.";
  const lines = steps.map(({ step, slot }) => {
    const n = doc.steps.indexOf(step) + 1;
    const length = `${step.duration.amount} ${step.duration.unit === "d" ? "ngày" : "giờ"}`;
    return { n, title: step.title.trim() || "(chưa đặt tên)", length, start: longMoment(slot.start), end: longMoment(slot.end) };
  });
  const by = sentBy ? `Lời nhắc này được gửi theo yêu cầu của ${sentBy}.` : "";
  const footer = "Đây là email tự động từ hệ thống Workflow, vui lòng không trả lời email này.";

  const text = [
    greeting,
    "",
    lead,
    "",
    ...lines.map((l) => `• Bước ${l.n}: ${l.title}\n  Thời lượng: ${l.length} · Bắt đầu: ${l.start} · Hạn: ${l.end}`),
    "",
    ask,
    `Mở workflow: ${link}`,
    ...(by ? ["", by] : []),
    "",
    "Trân trọng cảm ơn sự phối hợp của Quý Anh/Chị.",
    "",
    "Trân trọng,",
    "Hệ thống Workflow",
    "",
    `— ${footer}`,
  ].join("\n");

  const accent = "#6d28d9";
  const html = `<!doctype html><html lang="vi"><body style="margin:0;background:#f4f4f7;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1f2937">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f7;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb">
<tr><td style="background:${accent};color:#ffffff;padding:14px 24px;font-size:13px;font-weight:600;letter-spacing:.02em">XÁC NHẬN TIMELINE</td></tr>
<tr><td style="padding:24px">
<p style="margin:0 0 12px;font-size:15px">${escape(greeting)}</p>
<p style="margin:0 0 16px;font-size:15px;line-height:1.6">${escape(lead)}</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:13px;margin:0 0 16px">
<tr style="background:#f9fafb;color:#6b7280"><td style="padding:8px 10px;border:1px solid #e5e7eb">Bước</td><td style="padding:8px 10px;border:1px solid #e5e7eb">Thời lượng</td><td style="padding:8px 10px;border:1px solid #e5e7eb">Bắt đầu → Hạn</td></tr>
${lines.map((l) => `<tr><td style="padding:8px 10px;border:1px solid #e5e7eb;vertical-align:top"><strong>${l.n}.</strong> ${escape(l.title)}</td><td style="padding:8px 10px;border:1px solid #e5e7eb;vertical-align:top;white-space:nowrap;font-weight:600">${escape(l.length)}</td><td style="padding:8px 10px;border:1px solid #e5e7eb;vertical-align:top">${escape(l.start)}<br>→ ${escape(l.end)}</td></tr>`).join("\n")}
</table>
<p style="margin:0 0 20px;font-size:15px;line-height:1.6">${escape(ask)}</p>
<p style="margin:0 0 20px"><a href="${escape(link)}" style="display:inline-block;background:${accent};color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:8px;font-size:14px;font-weight:600">Mở workflow để xác nhận</a></p>
${by ? `<p style="margin:0 0 16px;font-size:13px;color:#6b7280">${escape(by)}</p>` : ""}
<p style="margin:0;font-size:15px;line-height:1.6">Trân trọng cảm ơn sự phối hợp của Quý Anh/Chị.<br><br>Trân trọng,<br><strong>Hệ thống Workflow</strong></p>
</td></tr>
<tr><td style="padding:14px 24px;background:#f9fafb;border-top:1px solid #e5e7eb;font-size:12px;color:#9ca3af">${escape(footer)}</td></tr>
</table></td></tr></table></body></html>`;

  return { subject, text, html };
}
