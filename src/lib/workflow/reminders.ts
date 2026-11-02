// Which steps get a reminder e-mail, and the e-mail itself. Pure functions (tested with node:test);
// the server side that loads plans and sends mail is src/lib/workflow/reminders-server.ts.
import { dayMark, minutesPerDay, normalizeStart, workBetween, type Slot, type WorkHours, type WorkflowDoc, type WorkflowStep } from "./model.ts";

/** upcoming: starts on the next working day · due: ends today · overdue · progress: running (sent by hand) */
export type ReminderKind = "upcoming" | "due" | "overdue" | "progress";

const DAY = 1440;

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

/** The reminder a step needs now, if any (done steps never get one). */
export function reminderKind(step: WorkflowStep, slot: Slot | undefined, now: number, hours: WorkHours, manual = false): ReminderKind | null {
  if (!slot || step.status === "done") return null;
  const today = Math.floor(now / DAY);
  if (slot.end < now) return "overdue";
  if (Math.floor(slot.end / DAY) === today) return "due";
  // the next working day: tomorrow, or Monday when today is Friday
  const nextWorkday = Math.floor(normalizeStart((today + 1) * DAY, hours) / DAY);
  const startDay = Math.floor(slot.start / DAY);
  if (step.status === "todo" && slot.start > now && startDay > today && startDay <= nextWorkday) return "upcoming";
  if (!manual) return null;
  return slot.start > now ? "upcoming" : "progress";
}

/** The automatic reminders of a plan for today: none on days off. */
export function dueReminders(doc: WorkflowDoc, slots: Map<string, Slot>, now: number): { stepId: string; kind: ReminderKind }[] {
  if (!isWorkday(Math.floor(now / DAY), doc.hours)) return [];
  return doc.steps.flatMap((s) => {
    const kind = reminderKind(s, slots.get(s.id), now, doc.hours);
    return kind ? [{ stepId: s.id, kind }] : [];
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

  const lead: Record<ReminderKind, string> = {
    upcoming: `Hệ thống Workflow trân trọng thông báo: công việc dưới đây do nhóm ${team} phụ trách sẽ bắt đầu vào ${longMoment(slot.start)}, với thời gian thực hiện dự kiến là ${length}.`,
    due: `Hệ thống Workflow trân trọng nhắc: công việc dưới đây do nhóm ${team} phụ trách sẽ đến hạn hoàn thành vào ${longMoment(slot.end)} hôm nay và hiện chưa được đánh dấu hoàn thành.`,
    overdue: `Hệ thống Workflow trân trọng thông báo: công việc dưới đây do nhóm ${team} phụ trách đã quá hạn hoàn thành (${longMoment(slot.end)}) và hiện chưa được đánh dấu hoàn thành.`,
    progress: `Hệ thống Workflow trân trọng nhắc: công việc dưới đây do nhóm ${team} phụ trách đang trong thời gian thực hiện, với hạn hoàn thành là ${longMoment(slot.end)}.`,
  };
  const ask: Record<ReminderKind, string> = {
    upcoming: "Kính mong Quý Anh/Chị sắp xếp thời gian để bắt đầu đúng kế hoạch.",
    due: "Nếu công việc đã hoàn thành, kính đề nghị Quý Anh/Chị cập nhật trạng thái trên trang workflow. Nếu cần thêm thời gian, Quý Anh/Chị vui lòng gia hạn trực tiếp trên trang và nêu rõ lý do.",
    overdue: "Kính đề nghị Quý Anh/Chị khẩn trương hoàn tất và cập nhật trạng thái, hoặc gia hạn trên trang workflow kèm lý do, để các bước tiếp theo được điều chỉnh kịp thời.",
    progress: "Kính mong Quý Anh/Chị theo dõi để hoàn thành đúng hạn. Nếu cần thêm thời gian, Quý Anh/Chị vui lòng gia hạn trên trang workflow và nêu rõ lý do.",
  };
  const label: Record<ReminderKind, string> = {
    upcoming: "Sắp bắt đầu",
    due: "Đến hạn hôm nay",
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

  const accent = kind === "overdue" ? "#e11d48" : kind === "due" ? "#d97706" : "#6d28d9";
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
