// Documents inbox: views, filters and their URL form, and the CSV export of
// search results. Pure: no Supabase imports, so tests, server pages and
// client components share it. The filter keys are the p_filters keys of
// search_documents (202608280042_document_search_reports.sql).

import type { OrgRole } from "../org.ts";
import {
  CONFIDENTIALITIES,
  DIRECTIONS,
  INCOMING_STATUSES,
  OUTGOING_STATUSES,
  URGENCIES,
  statusesFor,
  type Confidentiality,
  type Direction,
  type DocumentStatus,
  type Urgency,
} from "./types.ts";
import { DIRECTION_LABELS, URGENCY_LABELS, statusLabel } from "./labels.ts";

// ---------------------------------------------------------------- views

export const DOCUMENT_VIEW_KEYS = [
  "needs_me",
  "awaiting_approval",
  "due_soon",
  "overdue",
  "for_info",
  "to_register",
  "to_issue",
  "following",
  "created_by_me",
  "done",
  "all",
] as const;
export type DocumentView = (typeof DOCUMENT_VIEW_KEYS)[number];

export type DocumentViewDef = {
  key: DocumentView;
  label: string;
  /** shown only to members holding one of these roles; absent = everyone */
  roles?: readonly OrgRole[];
};

/** Inbox views in display order. */
export const DOCUMENT_VIEWS: readonly DocumentViewDef[] = [
  { key: "needs_me", label: "Needs me (Cần xử lý)" },
  { key: "awaiting_approval", label: "Awaiting my approval (Chờ duyệt)" },
  { key: "due_soon", label: "Due soon (Sắp đến hạn)" },
  { key: "overdue", label: "Overdue (Quá hạn)" },
  { key: "for_info", label: "For information (Để biết)" },
  { key: "to_register", label: "To register (Chờ vào sổ)", roles: ["clerk"] },
  { key: "to_issue", label: "Ready to issue (Chờ phát hành)", roles: ["clerk"] },
  { key: "following", label: "Following (Theo dõi)" },
  { key: "created_by_me", label: "Created by me" },
  { key: "done", label: "Done (Đã xử lý)" },
  { key: "all", label: "All documents" },
];

export const DEFAULT_DOCUMENT_VIEW: DocumentView = "needs_me";

export function isDocumentView(value: unknown): value is DocumentView {
  return typeof value === "string" && (DOCUMENT_VIEW_KEYS as readonly string[]).includes(value);
}

/** The views a member with `roles` may open (role-limited views need one of their roles). */
export function visibleViews(roles: readonly string[] | null | undefined): DocumentViewDef[] {
  return DOCUMENT_VIEWS.filter((v) => !v.roles || v.roles.some((r) => roles?.includes(r)));
}

/** Label of a view, or the raw key when it is not known. */
export function viewLabel(view: string): string {
  return DOCUMENT_VIEWS.find((v) => v.key === view)?.label ?? view;
}

// ---------------------------------------------------------------- filters

/** search_documents p_filters; every key is optional and empty keys are left out. */
export type DocumentFilters = {
  view?: DocumentView;
  direction?: Direction;
  status?: DocumentStatus[];
  register_id?: string;
  year?: number;
  q?: string;
  doc_type_id?: string;
  field_id?: string;
  urgency?: Urgency;
  confidentiality?: Confidentiality;
  /** yyyy-mm-dd, on the issued date, else the arrival date */
  date_from?: string;
  date_to?: string;
  department_id?: string;
  external_org_id?: string;
};

/** URL / p_filters keys in a fixed order (stable URLs). */
const FILTER_KEYS = [
  "view",
  "q",
  "direction",
  "status",
  "doc_type_id",
  "field_id",
  "urgency",
  "confidentiality",
  "register_id",
  "year",
  "date_from",
  "date_to",
  "department_id",
  "external_org_id",
] as const satisfies readonly (keyof DocumentFilters)[];

const UUID_KEYS = ["register_id", "doc_type_id", "field_id", "department_id", "external_org_id"] as const;

/** the server accepts up to 200 characters */
export const MAX_QUERY_LENGTH = 200;
const MIN_YEAR = 1900;
const MAX_YEAR = 2999;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ALL_STATUSES: readonly string[] = [...new Set<string>([...INCOMING_STATUSES, ...OUTGOING_STATUSES])];

function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/** True for a real calendar date written yyyy-mm-dd. */
export function isIsoDay(value: string): boolean {
  const m = DAY_RE.exec(value);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === value;
}

function oneOf<T extends string>(list: readonly T[], value: string | null | undefined): T | undefined {
  return value && (list as readonly string[]).includes(value) ? (value as T) : undefined;
}

/**
 * Valid statuses only, without duplicates, in their canonical order; with a
 * direction, only the statuses that direction can have.
 */
function cleanStatuses(values: readonly string[], direction: Direction | undefined): DocumentStatus[] | undefined {
  const allowed: readonly string[] = direction ? statusesFor(direction) : ALL_STATUSES;
  const wanted = new Set(values.map((v) => v.trim()).filter(Boolean));
  const kept = allowed.filter((s) => wanted.has(s)) as DocumentStatus[];
  return kept.length ? kept : undefined;
}

/**
 * Validates filters from any source (URL, form state, saved JSON): unknown
 * enum values, malformed ids and dates are dropped, text is trimmed, and
 * empty values are left out. The result has only defined keys.
 */
export function normalizeFilters(input: Partial<Record<keyof DocumentFilters, unknown>>): DocumentFilters {
  const out: DocumentFilters = {};
  const text = (v: unknown) => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");

  const view = text(input.view);
  if (isDocumentView(view)) out.view = view;

  const q = text(input.q).replace(/\s+/g, " ").slice(0, MAX_QUERY_LENGTH).trim();
  if (q) out.q = q;

  const direction = oneOf(DIRECTIONS, text(input.direction));
  if (direction) out.direction = direction;

  const rawStatus = Array.isArray(input.status)
    ? input.status.map(text)
    : text(input.status).split(",");
  const status = cleanStatuses(rawStatus, direction);
  if (status) out.status = status;

  for (const key of UUID_KEYS) {
    const id = text(input[key]).toLowerCase();
    if (isUuid(id)) out[key] = id;
  }

  const urgency = oneOf(URGENCIES, text(input.urgency));
  if (urgency) out.urgency = urgency;
  const confidentiality = oneOf(CONFIDENTIALITIES, text(input.confidentiality));
  if (confidentiality) out.confidentiality = confidentiality;

  const yearText = text(input.year);
  if (/^\d{4}$/.test(yearText)) {
    const year = Number(yearText);
    if (year >= MIN_YEAR && year <= MAX_YEAR) out.year = year;
  }

  const from = text(input.date_from);
  if (isIsoDay(from)) out.date_from = from;
  const to = text(input.date_to);
  if (isIsoDay(to)) out.date_to = to;

  return out;
}

/** Reads filters from a URL query (?view=…&status=a,b); invalid values are dropped. */
export function filtersFromSearchParams(sp: URLSearchParams): DocumentFilters {
  const raw: Partial<Record<keyof DocumentFilters, unknown>> = {};
  for (const key of FILTER_KEYS) {
    if (key === "status") {
      // ?status=a,b and ?status=a&status=b both work
      const all = sp.getAll("status").flatMap((s) => s.split(","));
      if (all.length) raw.status = all;
    } else {
      const value = sp.get(key);
      if (value !== null) raw[key] = value;
    }
  }
  return normalizeFilters(raw);
}

/** Writes filters as a URL query in a stable key order; empty values are left out. */
export function filtersToSearchParams(f: DocumentFilters): URLSearchParams {
  const clean = normalizeFilters(f);
  const sp = new URLSearchParams();
  for (const key of FILTER_KEYS) {
    const value = clean[key];
    if (value === undefined) continue;
    sp.set(key, Array.isArray(value) ? value.join(",") : String(value));
  }
  return sp;
}

/** True when no filter other than the view is set ("Clear filters" hidden). */
export function hasActiveFilters(f: DocumentFilters): boolean {
  return Object.keys(normalizeFilters(f)).some((key) => key !== "view");
}

// ---------------------------------------------------------------- results

/** One row of search_documents. Dates are yyyy-mm-dd, timestamps ISO strings. */
export type DocumentSearchRow = {
  id: string;
  direction: Direction;
  status: DocumentStatus;
  subject: string;
  notation: string | null;
  number: number | null;
  arrival_number: number | null;
  arrival_date: string | null;
  issued_date: string | null;
  issuing_org_name: string | null;
  type_name: string | null;
  urgency: Urgency;
  confidentiality: Confidentiality;
  due_date: string | null;
  /** the caller's earliest open assignment deadline */
  my_due_date: string | null;
  updated_at: string;
  created_at: string;
  /** up to three recipient names, then '+N' */
  recipients_summary: string | null;
  total_count: number;
};

/** document_dashboard(): counts for the inbox cards. */
export type DocumentDashboard = {
  needs_me: number;
  for_info: number;
  awaiting_approval: number;
  due_soon: number;
  overdue: number;
  to_register: number;
  to_issue: number;
  /** needs_me with an urgency above normal */
  urgent: number;
};

export const EMPTY_DASHBOARD: DocumentDashboard = {
  needs_me: 0,
  for_info: 0,
  awaiting_approval: 0,
  due_soon: 0,
  overdue: 0,
  to_register: 0,
  to_issue: 0,
  urgent: 0,
};

/** report_incoming_processing(): one department/assignee row, or the 'Total' row. */
export type IncomingReportRow = {
  department_id: string | null;
  department_name: string;
  assignee_user_id: string | null;
  assignee_name: string | null;
  received: number;
  done_on_time: number;
  done_late: number;
  open_on_time: number;
  open_overdue: number;
  /** average days from assignment to done; null when nothing is done */
  avg_days: number | null;
};

/** report_outgoing(): issued documents per month ('YYYY-MM') and type. */
export type OutgoingReportRow = {
  month: string;
  type_name: string;
  issued: number;
  /** average hours from the final submission to signing */
  avg_approval_hours: number | null;
};

// ---------------------------------------------------------------- CSV

const CSV_BOM = "﻿";

/** yyyy-mm-dd (or an ISO timestamp's date part) → dd/MM/yyyy; '' when empty. */
function csvDate(value: string | null | undefined): string {
  const m = value ? /^(\d{4})-(\d{2})-(\d{2})/.exec(value) : null;
  return m ? `${m[3]}/${m[2]}/${m[1]}` : "";
}

/**
 * One CSV field (RFC 4180): quoted when it holds a comma, quote, CR or LF,
 * with quotes doubled. Text that a spreadsheet would run as a formula
 * (= + - @ or a leading tab/CR) is prefixed with an apostrophe.
 */
export function csvField(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  let s = String(value);
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function numberCell(row: DocumentSearchRow): string {
  if (row.direction === "incoming") {
    return [row.arrival_number != null ? `Đến ${row.arrival_number}` : "", row.notation ?? ""]
      .filter(Boolean)
      .join(" · ");
  }
  return row.notation ?? "";
}

const CSV_COLUMNS: { header: string; value: (row: DocumentSearchRow) => string | number | null }[] = [
  { header: "Number (Số, ký hiệu)", value: numberCell },
  { header: "Direction", value: (r) => DIRECTION_LABELS[r.direction] ?? r.direction },
  { header: "Type (Loại văn bản)", value: (r) => r.type_name },
  { header: "Subject (Trích yếu)", value: (r) => r.subject },
  {
    header: "From / To",
    value: (r) => (r.direction === "incoming" ? r.issuing_org_name : r.recipients_summary),
  },
  { header: "Arrival date (Ngày đến)", value: (r) => csvDate(r.arrival_date) },
  { header: "Document date (Ngày văn bản)", value: (r) => csvDate(r.issued_date) },
  { header: "Urgency (Độ khẩn)", value: (r) => URGENCY_LABELS[r.urgency] ?? r.urgency },
  { header: "Due (Hạn xử lý)", value: (r) => csvDate(r.my_due_date ?? r.due_date) },
  { header: "Status", value: (r) => statusLabel(r.status) },
];

/**
 * Search results as CSV for Excel: a UTF-8 BOM (so Vietnamese shows
 * correctly), CRLF line ends, RFC 4180 quoting and dd/MM/yyyy dates.
 */
export function csvForResults(rows: readonly DocumentSearchRow[]): string {
  const lines = [
    CSV_COLUMNS.map((c) => csvField(c.header)).join(","),
    ...rows.map((row) => CSV_COLUMNS.map((c) => csvField(c.value(row))).join(",")),
  ];
  return CSV_BOM + lines.join("\r\n") + "\r\n";
}
