// Documents reports page helpers: durations, on-time rates, the department →
// person grouping of report_incoming_processing, the month × type table of
// report_outgoing and their CSV. Pure: no Supabase imports, so tests and the
// client component share it. The row shapes come from
// 202608280042_document_search_reports.sql (see filters.ts).

import { csvField, type IncomingReportRow, type OutgoingReportRow } from "./filters.ts";

const DASH = "—";
const CSV_BOM = "﻿";

// ---------------------------------------------------------------- formatting

/**
 * Hours as days and hours, rounded to the nearest hour: 51 → '2 d 3 h',
 * 48 → '2 d', 5 → '5 h', 0.2 → '< 1 h', 0 → '0 h'. Null, negative or not a
 * number → '—'.
 */
export function formatDuration(hours: number | null | undefined): string {
  if (hours === null || hours === undefined || !Number.isFinite(hours) || hours < 0) return DASH;
  const total = Math.round(hours);
  if (total === 0) return hours > 0 ? "< 1 h" : "0 h";
  const days = Math.floor(total / 24);
  const rest = total % 24;
  if (days === 0) return `${rest} h`;
  return rest === 0 ? `${days} d` : `${days} d ${rest} h`;
}

type OutcomeCounts = Pick<IncomingReportRow, "done_on_time" | "done_late" | "open_overdue">;

/**
 * Share of assignments whose outcome is known that were handled on time:
 * done on time / (done on time + done late + open and overdue), as a whole
 * percentage ('83%'). Open assignments that are not yet due are left out,
 * since they can still finish either way. '—' when nothing is known yet.
 */
export function onTimeRate(row: OutcomeCounts): string {
  const known = row.done_on_time + row.done_late + row.open_overdue;
  if (!(known > 0)) return DASH;
  return `${Math.round((row.done_on_time / known) * 100)}%`;
}

/** 'YYYY-MM' → 'MM/YYYY'; anything else is returned unchanged. */
export function monthLabel(month: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  return m ? `${m[2]}/${m[1]}` : month;
}

/** Average days with one decimal ('2.5'); '—' when there is none. */
export function formatDays(days: number | null | undefined): string {
  if (days === null || days === undefined || !Number.isFinite(days)) return DASH;
  return (Math.round(days * 10) / 10).toFixed(1);
}

/**
 * The first and last day (yyyy-mm-dd) of the month that contains `day`
 * (yyyy-mm-dd, e.g. today in the company time zone). Null for a bad day.
 */
export function monthRange(day: string): { from: string; to: string } | null {
  const m = /^(\d{4})-(\d{2})-\d{2}$/.exec(day);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  // day 0 of the next month is the last day of this one
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { from: `${m[1]}-${m[2]}-01`, to: `${m[1]}-${m[2]}-${String(last).padStart(2, "0")}` };
}

// ---------------------------------------------------------------- incoming grouping

export type ReportCounts = {
  received: number;
  done_on_time: number;
  done_late: number;
  open_on_time: number;
  open_overdue: number;
  /** average days from assignment to done; null when nothing is done */
  avg_days: number | null;
};

/** One assignee inside a department (a person, or the department as a whole). */
export type ReportPersonLine = ReportCounts & {
  key: string;
  user_id: string | null;
  label: string;
};

/** A department with its people, or the Total line (always last, no people). */
export type ReportGroup = ReportCounts & {
  kind: "department" | "total";
  key: string;
  department_id: string | null;
  label: string;
  people: ReportPersonLine[];
};

const ZERO: ReportCounts = {
  received: 0,
  done_on_time: 0,
  done_late: 0,
  open_on_time: 0,
  open_overdue: 0,
  avg_days: null,
};

function countsOf(row: ReportCounts): ReportCounts {
  return {
    received: row.received,
    done_on_time: row.done_on_time,
    done_late: row.done_late,
    open_on_time: row.open_on_time,
    open_overdue: row.open_overdue,
    avg_days: row.avg_days,
  };
}

/**
 * Sums counts. The average is weighted by the number of done assignments
 * (the rows' averages are already rounded, so the result is close to, not
 * exactly, the server's own average) and rounded to one decimal.
 */
function sumCounts(rows: readonly ReportCounts[]): ReportCounts {
  const out = { ...ZERO };
  let weighted = 0;
  let weight = 0;
  for (const r of rows) {
    out.received += r.received;
    out.done_on_time += r.done_on_time;
    out.done_late += r.done_late;
    out.open_on_time += r.open_on_time;
    out.open_overdue += r.open_overdue;
    const done = r.done_on_time + r.done_late;
    if (r.avg_days !== null && Number.isFinite(r.avg_days) && done > 0) {
      weighted += r.avg_days * done;
      weight += done;
    }
  }
  out.avg_days = weight > 0 ? Math.round((weighted / weight) * 10) / 10 : null;
  return out;
}

/** The server's grand total: no department, no person, named 'Total'. */
function isTotalRow(row: IncomingReportRow): boolean {
  return row.department_id === null && row.assignee_user_id === null && row.department_name === "Total";
}

/**
 * report_incoming_processing rows → departments (in the server's order) with
 * their people nested, then one Total line. A department's numbers are the
 * sum of its people. The Total line is the server's total row when present,
 * else the sum of every department.
 */
export function groupReportRows(rows: readonly IncomingReportRow[]): ReportGroup[] {
  const groups = new Map<string, ReportGroup>();
  let serverTotal: IncomingReportRow | null = null;

  for (const row of rows) {
    if (isTotalRow(row)) {
      serverTotal = row;
      continue;
    }
    const key = row.department_id ?? "none";
    let group = groups.get(key);
    if (!group) {
      group = {
        kind: "department",
        key: `dept:${key}`,
        department_id: row.department_id,
        label: row.department_name || "No department",
        people: [],
        ...ZERO,
      };
      groups.set(key, group);
    }
    group.people.push({
      ...countsOf(row),
      key: `person:${key}:${row.assignee_user_id ?? "unit"}`,
      user_id: row.assignee_user_id,
      label:
        row.assignee_user_id === null
          ? "Whole department"
          : row.assignee_name?.trim() || "Unknown person",
    });
  }

  const departments = [...groups.values()].map((g) => ({ ...g, ...sumCounts(g.people) }));
  const total: ReportGroup = {
    kind: "total",
    key: "total",
    department_id: null,
    label: "Total",
    people: [],
    ...(serverTotal ? countsOf(serverTotal) : sumCounts(departments)),
  };
  return [...departments, total];
}

// ---------------------------------------------------------------- outgoing table

export type OutgoingCell = { issued: number; avg_approval_hours: number | null };

export type OutgoingMonthLine = OutgoingCell & {
  month: string;
  label: string;
  /** by type name; a type with nothing issued that month is missing */
  cells: Record<string, OutgoingCell>;
};

export type OutgoingTable = {
  /** type names, alphabetical (Vietnamese order) */
  types: string[];
  months: OutgoingMonthLine[];
  /** per type over every month */
  typeTotals: Record<string, OutgoingCell>;
  total: OutgoingCell;
};

/** Issued-weighted average of the cells' averages (approximate: see sumCounts). */
function sumCells(cells: readonly OutgoingCell[]): OutgoingCell {
  let issued = 0;
  let weighted = 0;
  let weight = 0;
  for (const c of cells) {
    issued += c.issued;
    if (c.avg_approval_hours !== null && Number.isFinite(c.avg_approval_hours) && c.issued > 0) {
      weighted += c.avg_approval_hours * c.issued;
      weight += c.issued;
    }
  }
  return { issued, avg_approval_hours: weight > 0 ? Math.round((weighted / weight) * 10) / 10 : null };
}

/** report_outgoing rows → months (oldest first) × types, with totals. */
export function pivotOutgoing(rows: readonly OutgoingReportRow[]): OutgoingTable {
  const types = [...new Set(rows.map((r) => r.type_name))].sort((a, b) => a.localeCompare(b, "vi"));
  const byMonth = new Map<string, Record<string, OutgoingCell>>();
  for (const r of rows) {
    const cells = byMonth.get(r.month) ?? {};
    const prev = cells[r.type_name];
    const cell = { issued: r.issued, avg_approval_hours: r.avg_approval_hours };
    cells[r.type_name] = prev ? sumCells([prev, cell]) : cell;
    byMonth.set(r.month, cells);
  }
  const months = [...byMonth.keys()].sort().map((month) => {
    const cells = byMonth.get(month) ?? {};
    return { month, label: monthLabel(month), cells, ...sumCells(Object.values(cells)) };
  });
  const typeTotals: Record<string, OutgoingCell> = {};
  for (const t of types) {
    typeTotals[t] = sumCells(months.flatMap((m) => (m.cells[t] ? [m.cells[t]] : [])));
  }
  // from the cells, not the month lines: a month's average covers only its
  // cells that have one
  return { types, months, typeTotals, total: sumCells(months.flatMap((m) => Object.values(m.cells))) };
}

// ---------------------------------------------------------------- CSV

function csv(lines: readonly (readonly (string | number | null)[])[]): string {
  return CSV_BOM + lines.map((cells) => cells.map(csvField).join(",")).join("\r\n") + "\r\n";
}

const INCOMING_CSV_HEADERS = [
  "Department",
  "Person",
  "Received",
  "Done on time",
  "Done late",
  "Open (on time)",
  "Open (overdue)",
  "Avg days",
  "On-time rate",
];

function incomingCells(row: ReportCounts): (string | number)[] {
  return [
    row.received,
    row.done_on_time,
    row.done_late,
    row.open_on_time,
    row.open_overdue,
    row.avg_days === null ? "" : formatDays(row.avg_days),
    onTimeRate(row) === DASH ? "" : onTimeRate(row),
  ];
}

/**
 * The incoming processing table as CSV (UTF-8 BOM, CRLF): each department
 * line, its people under it, then the Total line.
 */
export function incomingReportCsv(groups: readonly ReportGroup[]): string {
  const lines: (string | number)[][] = [INCOMING_CSV_HEADERS];
  for (const g of groups) {
    lines.push([g.label, "", ...incomingCells(g)]);
    for (const p of g.people) lines.push([g.label, p.label, ...incomingCells(p)]);
  }
  return csv(lines);
}

/** report_outgoing rows as CSV, one line per month and type, then the total. */
export function outgoingReportCsv(rows: readonly OutgoingReportRow[]): string {
  const table = pivotOutgoing(rows);
  const lines: (string | number)[][] = [
    ["Month", "Document type", "Issued", "Avg approval time", "Avg approval hours"],
  ];
  for (const m of table.months) {
    for (const t of table.types) {
      const cell = m.cells[t];
      if (!cell) continue;
      lines.push([
        m.label,
        t,
        cell.issued,
        cell.avg_approval_hours === null ? "" : formatDuration(cell.avg_approval_hours),
        cell.avg_approval_hours ?? "",
      ]);
    }
  }
  lines.push([
    "Total",
    "",
    table.total.issued,
    table.total.avg_approval_hours === null ? "" : formatDuration(table.total.avg_approval_hours),
    table.total.avg_approval_hours ?? "",
  ]);
  return csv(lines);
}
