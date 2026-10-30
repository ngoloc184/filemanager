// Working-day deadlines for documents. Mirrors doc_add_working_days and
// doc_default_due_days in 202608280036_documents_core.sql: working days are
// Monday to Friday minus the company's holidays (org_holidays). Dates are
// plain 'yyyy-mm-dd' strings in the company's time zone; overdue is computed,
// never stored.

import type { Urgency } from "./types.ts";

export const DEFAULT_ORG_TIME_ZONE = "Asia/Ho_Chi_Minh";

export type DueState = "overdue" | "due_today" | "due_soon" | "ok";

/** A deadline this many working days away (or fewer) is "due soon". */
export const DUE_SOON_WORKING_DAYS = 2;

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

function parseDay(day: string): number {
  const m = DAY_RE.exec(day);
  if (!m) throw new Error(`Invalid date "${day}" (expected yyyy-mm-dd)`);
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (formatDayMs(ms) !== day) throw new Error(`Invalid date "${day}"`);
  return ms;
}

function formatDayMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** True for Monday–Friday that is not in `holidays`. */
export function isWorkingDay(day: string, holidays: ReadonlySet<string> = new Set()): boolean {
  const weekday = new Date(parseDay(day)).getUTCDay();
  return weekday !== 0 && weekday !== 6 && !holidays.has(day);
}

/**
 * The date `days` working days after `from` (Saturday + 1 = Monday, the
 * inverse of workingDaysBetween). With 0 days it is `from` when that is a
 * working day, else the next working day (same as SQL).
 * Negative or fractional counts are treated as 0 / rounded down.
 */
export function addWorkingDays(
  from: string,
  days: number,
  holidays: ReadonlySet<string> = new Set()
): string {
  let ms = parseDay(from);
  let left = Math.max(0, Math.floor(days));
  if (left === 0) {
    while (!isWorkingDay(formatDayMs(ms), holidays)) ms += DAY_MS;
    return formatDayMs(ms);
  }
  while (left > 0) {
    ms += DAY_MS;
    if (isWorkingDay(formatDayMs(ms), holidays)) left--;
  }
  return formatDayMs(ms);
}

/**
 * Working days after `from` up to and including `to` (0 when `to` <= `from`).
 * Counting stops once it passes `stopAfter`, so far-off dates stay cheap.
 */
export function workingDaysBetween(
  from: string,
  to: string,
  holidays: ReadonlySet<string> = new Set(),
  stopAfter = Infinity
): number {
  const end = parseDay(to);
  let count = 0;
  for (let ms = parseDay(from) + DAY_MS; ms <= end && count <= stopAfter; ms += DAY_MS) {
    if (isWorkingDay(formatDayMs(ms), holidays)) count++;
  }
  return count;
}

/** Default processing time by urgency (a proposal): normal 7, khẩn 2, thượng khẩn 1, hỏa tốc 0. */
export function defaultDueDays(urgency: Urgency | string | null | undefined): number {
  switch (urgency) {
    case "khan":
      return 2;
    case "thuong_khan":
      return 1;
    case "hoa_toc":
      return 0;
    default:
      return 7;
  }
}

/** Default deadline for a document of `urgency` received on `from`. */
export function defaultDueDate(
  from: string,
  urgency: Urgency | string | null | undefined,
  holidays: ReadonlySet<string> = new Set()
): string {
  return addWorkingDays(from, defaultDueDays(urgency), holidays);
}

/**
 * Where a deadline stands on `today`: overdue (past), due_today, due_soon
 * (at most 2 working days away), ok; null without a deadline.
 */
export function dueState(
  due: string | null | undefined,
  today: string,
  holidays: ReadonlySet<string> = new Set()
): DueState | null {
  if (!due) return null;
  // accept timestamps too: only the date part counts
  const dueDay = due.slice(0, 10);
  const todayDay = today.slice(0, 10);
  if (dueDay < todayDay) return "overdue";
  if (dueDay === todayDay) return "due_today";
  const away = workingDaysBetween(todayDay, dueDay, holidays, DUE_SOON_WORKING_DAYS);
  return away <= DUE_SOON_WORKING_DAYS ? "due_soon" : "ok";
}

/** Today's date (yyyy-mm-dd) in `timeZone`; an unknown zone falls back to Asia/Ho_Chi_Minh. */
export function todayIn(timeZone: string | null | undefined, now: Date = new Date()): string {
  const format = (zone: string) => {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(now);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
    return `${get("year")}-${get("month")}-${get("day")}`;
  };
  try {
    return format(timeZone || DEFAULT_ORG_TIME_ZONE);
  } catch {
    return format(DEFAULT_ORG_TIME_ZONE);
  }
}

/** Set of holiday days from org_holidays rows. */
export function holidaySet(rows: readonly { day: string }[] | null | undefined): Set<string> {
  return new Set((rows ?? []).map((r) => r.day));
}

/** 'yyyy-mm-dd' → 'dd/mm/yyyy' (Vietnamese order); other input is returned as is. */
export function formatDay(day: string | null | undefined): string {
  if (!day) return "";
  const m = DAY_RE.exec(day);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : day;
}
