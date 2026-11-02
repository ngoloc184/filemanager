import { CircleCheck, CircleDashed, CircleDot, OctagonAlert, type LucideIcon } from "lucide-react";
import { formatStamp, minutesPerDay, weekdayOf, type Duration, type RoleColor, type StepStatus, type WorkHours } from "@/lib/workflow/model";

/** Tailwind needs whole class names in the source, so each role color spells them out. */
export const ROLE_STYLE: Record<RoleColor, { chip: string; dot: string; bar: string; label: string }> = {
  violet: { chip: "bg-violet-500/10 text-violet-700 ring-violet-500/25 dark:text-violet-300", dot: "bg-violet-500", bar: "bg-violet-500", label: "Tím" },
  sky: { chip: "bg-sky-500/10 text-sky-700 ring-sky-500/25 dark:text-sky-300", dot: "bg-sky-500", bar: "bg-sky-500", label: "Xanh trời" },
  emerald: { chip: "bg-emerald-500/10 text-emerald-700 ring-emerald-500/25 dark:text-emerald-300", dot: "bg-emerald-500", bar: "bg-emerald-500", label: "Xanh lá" },
  amber: { chip: "bg-amber-500/12 text-amber-800 ring-amber-500/30 dark:text-amber-300", dot: "bg-amber-500", bar: "bg-amber-500", label: "Vàng" },
  rose: { chip: "bg-rose-500/10 text-rose-700 ring-rose-500/25 dark:text-rose-300", dot: "bg-rose-500", bar: "bg-rose-500", label: "Hồng" },
  teal: { chip: "bg-teal-500/10 text-teal-700 ring-teal-500/25 dark:text-teal-300", dot: "bg-teal-500", bar: "bg-teal-500", label: "Xanh ngọc" },
  orange: { chip: "bg-orange-500/10 text-orange-700 ring-orange-500/25 dark:text-orange-300", dot: "bg-orange-500", bar: "bg-orange-500", label: "Cam" },
  slate: { chip: "bg-slate-500/10 text-slate-700 ring-slate-500/25 dark:text-slate-300", dot: "bg-slate-500", bar: "bg-slate-500", label: "Xám" },
};

export const STATUS_META: Record<StepStatus, { label: string; icon: LucideIcon; text: string; ring: string }> = {
  todo: { label: "Chưa bắt đầu", icon: CircleDashed, text: "text-muted-foreground", ring: "ring-border" },
  doing: { label: "Đang làm", icon: CircleDot, text: "text-sky-600 dark:text-sky-400", ring: "ring-sky-500/50" },
  done: { label: "Hoàn thành", icon: CircleCheck, text: "text-emerald-600 dark:text-emerald-400", ring: "ring-emerald-500/50" },
  blocked: { label: "Bị chặn", icon: OctagonAlert, text: "text-rose-600 dark:text-rose-400", ring: "ring-rose-500/50" },
};

const WEEKDAYS = ["CN", "T2", "T3", "T4", "T5", "T6", "T7"];

export function weekdayLabel(t: number): string {
  return WEEKDAYS[weekdayOf(t)];
}

/** "T2 02/11" */
export function shortDay(t: number): string {
  const s = formatStamp(t);
  return `${weekdayLabel(t)} ${s.slice(8, 10)}/${s.slice(5, 7)}`;
}

/** "08:00" */
export function clock(t: number): string {
  return formatStamp(t).slice(11, 16);
}

/** "T2 02/11 08:00" */
export function shortMoment(t: number): string {
  return `${shortDay(t)} ${clock(t)}`;
}

/** "02/11/2026 08:00" */
export function fullMoment(t: number): string {
  const s = formatStamp(t);
  return `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)} ${s.slice(11, 16)}`;
}

/** "2 ngày", "4 giờ" */
export function durationLabel(d: Duration): string {
  return `${d.amount} ${d.unit === "d" ? "ngày" : "giờ"}`;
}

/** Working minutes as "1 ngày 4 giờ" (days of the plan's working hours). */
export function minutesLabel(minutes: number, hours: WorkHours): string {
  const perDay = minutesPerDay(hours);
  const days = Math.floor(minutes / perDay);
  const rest = Math.round(((minutes - days * perDay) / 60) * 10) / 10;
  const parts = [days ? `${days} ngày` : "", rest ? `${String(rest).replace(".", ",")} giờ` : ""].filter(Boolean);
  return parts.join(" ") || "0 giờ";
}

/** "T+2", "T+2,5" */
export function mark(n: number): string {
  return `T+${String(n).replace(".", ",")}`;
}

/** A log time (ISO with zone) in the viewer's clock: "02/11 14:05". */
export function logTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
