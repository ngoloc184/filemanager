// Display helpers for the Documents inbox table (/documents): the number and
// counterpart columns, dates, row tones, pagination text, empty states and
// the inbox URL. Pure: no Supabase or React imports, so tests share it.

import { dueState } from "./deadlines.ts";
import {
  DEFAULT_DOCUMENT_VIEW,
  filtersToSearchParams,
  type DocumentDashboard,
  type DocumentFilters,
  type DocumentSearchRow,
  type DocumentView,
} from "./filters.ts";
import { isFinalStatus, type Urgency } from "./types.ts";

type NumberFields = Pick<DocumentSearchRow, "direction" | "status" | "arrival_number" | "notation">;

/**
 * Number column: a registered incoming document shows its arrival number
 * ('Đến 12 · 45/CV-XYZ'), an issued one its notation ('01/QĐ-ABC'), a draft
 * 'Draft'; anything else without a number shows '—'.
 */
export function formatDocNumber(row: NumberFields): string {
  const notation = row.notation?.trim() || null;
  if (row.direction === "incoming" && row.arrival_number != null) {
    return notation ? `Đến ${row.arrival_number} · ${notation}` : `Đến ${row.arrival_number}`;
  }
  if (row.status === "draft") return "Draft";
  return notation ?? "—";
}

/** From / To column: the issuer of an incoming document, else the recipients. */
export function counterpart(
  row: Pick<DocumentSearchRow, "direction" | "issuing_org_name" | "recipients_summary">
): string {
  if (row.direction === "incoming") return row.issuing_org_name?.trim() || "—";
  const recipients = row.recipients_summary?.trim();
  if (recipients) return recipients;
  return row.direction === "internal" ? "Internal" : "—";
}

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * 'yyyy-mm-dd' → 'dd/MM/yyyy'. An ISO timestamp is shown as its date in the
 * viewer's time zone; empty input gives '' and unreadable input is returned as is.
 */
export function formatDate(value: string | null | undefined): string {
  if (!value) return "";
  const day = DAY_RE.exec(value);
  if (day) return `${day[3]}/${day[2]}/${day[1]}`;
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return value;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(at.getDate())}/${pad(at.getMonth() + 1)}/${at.getFullYear()}`;
}

export type RowTone = "danger" | "warning";

/**
 * Highlight of a row on `today` (yyyy-mm-dd, company time zone): 'danger'
 * when the caller's deadline (else the document's) has passed, 'warning' when
 * it is today or due soon, null otherwise and once the document is finished.
 */
export function rowTone(
  row: Pick<DocumentSearchRow, "status" | "due_date" | "my_due_date">,
  today: string,
  holidays?: ReadonlySet<string>
): RowTone | null {
  if (isFinalStatus(row.status)) return null;
  let state: ReturnType<typeof dueState>;
  try {
    state = dueState(row.my_due_date ?? row.due_date, today, holidays);
  } catch {
    return null; // a malformed date must not break the list
  }
  if (state === "overdue") return "danger";
  if (state === "due_today" || state === "due_soon") return "warning";
  return null;
}

/** Colour of the urgency stripe: hỏa tốc red, khẩn / thượng khẩn amber, normal none. */
export function urgencyTone(urgency: Urgency | string | null | undefined): RowTone | null {
  if (urgency === "hoa_toc") return "danger";
  if (urgency === "khan" || urgency === "thuong_khan") return "warning";
  return null;
}

/** 'Showing 51–100 of 120' for 1-based `page`; 'No results' when empty. */
export function pageRangeText(page: number, pageSize: number, total: number): string {
  if (total <= 0) return "No results";
  const size = Math.max(1, Math.floor(pageSize) || 1);
  const lastPage = Math.max(1, Math.ceil(total / size));
  const current = Math.min(Math.max(1, Math.floor(page) || 1), lastPage);
  const first = (current - 1) * size + 1;
  const last = Math.min(current * size, total);
  return `Showing ${first}–${last} of ${total}`;
}

/** Number of pages for `total` rows (at least 1). */
export function pageCount(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(Math.max(0, total) / Math.max(1, Math.floor(pageSize) || 1)));
}

/** The dashboard count shown on a view tab, or null for views without one. */
export function viewCount(dashboard: DocumentDashboard | null | undefined, view: DocumentView): number | null {
  if (!dashboard) return null;
  switch (view) {
    case "needs_me":
    case "awaiting_approval":
    case "due_soon":
    case "overdue":
    case "for_info":
    case "to_register":
    case "to_issue":
      return dashboard[view];
    default:
      return null;
  }
}

const EMPTY_MESSAGES: Record<DocumentView, string> = {
  needs_me: "Nothing needs you right now.",
  awaiting_approval: "Nothing is waiting for your approval.",
  due_soon: "Nothing is due soon.",
  overdue: "No overdue work.",
  for_info: "No documents sent to you for information.",
  to_register: "No incoming documents are waiting to be registered.",
  to_issue: "No signed documents are waiting to be issued.",
  following: "You are not following any open documents.",
  created_by_me: "You have not created any documents yet.",
  done: "Nothing finished yet.",
  all: "No documents yet.",
};

/** Empty-state text of a view; with filters set it points at the filters instead. */
export function emptyMessage(view: DocumentView, filtered = false): string {
  if (filtered) return "No documents match these filters.";
  return EMPTY_MESSAGES[view] ?? EMPTY_MESSAGES.all;
}

/**
 * Query string of the inbox for `filters` ('' or '?view=overdue&q=…'). The
 * default view is left out so a plain /documents opens it.
 */
export function inboxSearch(filters: DocumentFilters): string {
  const sp = filtersToSearchParams(filters);
  if (sp.get("view") === DEFAULT_DOCUMENT_VIEW) sp.delete("view");
  const query = sp.toString();
  return query ? `?${query}` : "";
}

/** 'documents-20261030.csv' for `today` = '2026-10-30'. */
export function csvFileName(today: string): string {
  const day = DAY_RE.exec(today.slice(0, 10));
  return day ? `documents-${day[1]}${day[2]}${day[3]}.csv` : "documents.csv";
}
