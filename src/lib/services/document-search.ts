import { createClient } from "@/lib/supabase/client";
import { getErrorMessage } from "@/lib/types/database";
import {
  EMPTY_DASHBOARD,
  normalizeFilters,
  type DocumentDashboard,
  type DocumentFilters,
  type DocumentSearchRow,
  type IncomingReportRow,
  type OutgoingReportRow,
} from "@/lib/documents/filters";

// Documents inbox, dashboard counts and reports: read-only RPCs from
// 202608280042_document_search_reports.sql. Every result is limited to the
// caller's company and to documents they can read.

export type {
  DocumentDashboard,
  DocumentFilters,
  DocumentSearchRow,
  IncomingReportRow,
  OutgoingReportRow,
} from "@/lib/documents/filters";

/** the server clamps a page to 1..200 rows */
const MAX_PAGE_SIZE = 200;

/** Explains a missing migration instead of showing PostgREST's raw error. */
function searchError(error: unknown): Error {
  const code = (error as { code?: string } | null)?.code;
  const message = getErrorMessage(error);
  if (code === "PGRST202" || /could not find the function/i.test(message)) {
    return new Error(
      "Document search is not set up yet. Run migration 202608280042_document_search_reports.sql."
    );
  }
  return new Error(message);
}

const toNumber = (value: unknown): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};
const toNumberOrNull = (value: unknown): number | null =>
  value === null || value === undefined ? null : toNumber(value);

async function searchPage(
  filters: DocumentFilters,
  limit: number,
  offset: number
): Promise<DocumentSearchRow[]> {
  const { data, error } = await createClient().rpc("search_documents", {
    p_filters: normalizeFilters(filters),
    p_limit: limit,
    p_offset: offset,
  });
  if (error) throw searchError(error);
  return ((data ?? []) as DocumentSearchRow[]).map((row) => ({
    ...row,
    total_count: toNumber(row.total_count),
  }));
}

/**
 * One page of the inbox for the given view and filters. `page` starts at 1;
 * `total` is the number of matching documents over all pages.
 */
export async function searchDocuments(
  filters: DocumentFilters,
  page: number,
  pageSize = 50
): Promise<{ rows: DocumentSearchRow[]; total: number }> {
  const size = Math.min(Math.max(Math.floor(pageSize) || 1, 1), MAX_PAGE_SIZE);
  const pageNo = Math.max(Math.floor(page) || 1, 1);
  const rows = await searchPage(filters, size, (pageNo - 1) * size);
  if (rows.length > 0) return { rows, total: rows[0].total_count };
  if (pageNo === 1) return { rows, total: 0 };
  // past the last page: the total still comes from the first row
  const first = await searchPage(filters, 1, 0);
  return { rows, total: first[0]?.total_count ?? 0 };
}

/** Counts for the inbox cards (needs me, overdue, …). */
export async function getDocumentDashboard(): Promise<DocumentDashboard> {
  const { data, error } = await createClient().rpc("document_dashboard");
  if (error) throw searchError(error);
  const raw = (data ?? {}) as Partial<Record<keyof DocumentDashboard, unknown>>;
  const out = { ...EMPTY_DASHBOARD };
  for (const key of Object.keys(EMPTY_DASHBOARD) as (keyof DocumentDashboard)[]) {
    out[key] = toNumber(raw[key] ?? 0);
  }
  return out;
}

/**
 * Processing of incoming documents that arrived between `from` and `to`
 * (yyyy-mm-dd): one row per department and assignee, then a 'Total' row.
 * Leaders, clerks and admins see every department; a department head only
 * the departments they head.
 */
export async function reportIncoming(
  from: string,
  to: string,
  departmentId?: string | null
): Promise<IncomingReportRow[]> {
  const { data, error } = await createClient().rpc("report_incoming_processing", {
    p_from: from,
    p_to: to,
    p_department_id: departmentId ?? null,
  });
  if (error) throw searchError(error);
  return ((data ?? []) as IncomingReportRow[]).map((row) => ({
    ...row,
    received: toNumber(row.received),
    done_on_time: toNumber(row.done_on_time),
    done_late: toNumber(row.done_late),
    open_on_time: toNumber(row.open_on_time),
    open_overdue: toNumber(row.open_overdue),
    avg_days: toNumberOrNull(row.avg_days),
  }));
}

/** Outgoing and internal documents issued between `from` and `to`, per month and type. */
export async function reportOutgoing(from: string, to: string): Promise<OutgoingReportRow[]> {
  const { data, error } = await createClient().rpc("report_outgoing", { p_from: from, p_to: to });
  if (error) throw searchError(error);
  return ((data ?? []) as OutgoingReportRow[]).map((row) => ({
    ...row,
    issued: toNumber(row.issued),
    avg_approval_hours: toNumberOrNull(row.avg_approval_hours),
  }));
}
