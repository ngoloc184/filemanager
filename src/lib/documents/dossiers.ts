// Dossiers (hồ sơ) and retention: types, labels, code suggestion, the
// transfer due date and the dossier manifest (mục lục văn bản). They mirror
// 202608280043_dossiers_retention.sql. Pure: no Supabase imports, so tests,
// server code and client components share them.

import type { Direction, DocumentStatus } from "./types.ts";

export const DOSSIER_STATUSES = ["open", "closed", "transferred"] as const;
export type DossierStatus = (typeof DOSSIER_STATUSES)[number];

export const DOSSIER_STATUS_LABELS: Record<DossierStatus, string> = {
  open: "Open",
  closed: "Closed",
  transferred: "Transferred to archive (Đã nộp lưu)",
};

/** One row of public.retention_codes; years null = permanent (Vĩnh viễn). */
export type RetentionCode = {
  id: string;
  org_id: string;
  code: string;
  label: string;
  years: number | null;
  sort_order: number;
};

/** One row of public.dossiers (dates are yyyy-mm-dd, timestamps ISO strings). */
export type DossierRow = {
  id: string;
  org_id: string;
  year: number;
  code: string;
  title: string;
  department_id: string | null;
  retention_code_id: string | null;
  owner_id: string | null;
  status: DossierStatus;
  legal_hold: boolean;
  is_capital_construction: boolean;
  start_date: string | null;
  end_date: string | null;
  transfer_due_date: string | null;
  closed_at: string | null;
  transferred_at: string | null;
  description: string | null;
  created_at: string;
};

/** get_dossier().dossier: the row plus display names and the caller's rights. */
export type DossierDetail = DossierRow & {
  department_name: string | null;
  department_code: string | null;
  retention_code: string | null;
  retention_label: string | null;
  retention_years: number | null;
  owner_name: string | null;
  /** owner, clerk or admin: may edit, file, unfile and close */
  can_manage: boolean;
  is_admin: boolean;
  is_clerk: boolean;
};

/** A document in a dossier the caller can read. */
export type DossierDocumentReadable = {
  document_id: string;
  ordinal: number;
  subject: string;
  notation: string | null;
  arrival_number: number | null;
  direction: Direction;
  status: DocumentStatus;
  issued_date: string | null;
  arrival_date: string | null;
  type_name: string | null;
  readable: true;
};

/** A document in a dossier the caller cannot read: only its id and place. */
export type DossierDocumentRestricted = {
  document_id: string;
  ordinal: number;
  readable: false;
};

export type DossierDocument = DossierDocumentReadable | DossierDocumentRestricted;

/** get_dossier(p_id) JSON. */
export type DossierBundle = {
  dossier: DossierDetail;
  documents: DossierDocument[];
};

/** A row of list_dossiers / dossiers_due_for_transfer. */
export type DossierListItem = {
  id: string;
  year: number;
  code: string;
  title: string;
  department_name: string | null;
  retention_label: string | null;
  owner_name: string | null;
  status: DossierStatus;
  legal_hold: boolean;
  doc_count: number;
  end_date: string | null;
  transfer_due_date: string | null;
};

/** A row of document_dossiers: the dossiers holding one document. */
export type DocumentDossier = {
  dossier_id: string;
  code: string;
  title: string;
  status: DossierStatus;
};

export const RESTRICTED_DOCUMENT_LABEL = "Restricted document";

// ---------------------------------------------------------------- code suggestion

/**
 * The next dossier code of a department: 'NN.DEPT' with NN one more than the
 * highest number already used by that department (gaps are not refilled, so
 * a code is never handed out twice), zero-padded to 2. Codes of other
 * departments are ignored. With no department code the suggestion is 'NN'.
 */
export function suggestDossierCode(existingCodes: readonly string[], deptCode: string): string {
  const dept = deptCode.trim().toUpperCase();
  let max = 0;
  for (const raw of existingCodes) {
    const code = raw.trim().toUpperCase();
    const dot = code.indexOf(".");
    const num = dot === -1 ? code : code.slice(0, dot);
    const rest = dot === -1 ? "" : code.slice(dot + 1);
    if (rest !== dept || !/^\d+$/.test(num)) continue;
    max = Math.max(max, Number(num));
  }
  const next = String(max + 1).padStart(2, "0");
  return dept ? `${next}.${dept}` : next;
}

// ---------------------------------------------------------------- dates

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

/**
 * Adds whole months to a yyyy-mm-dd day like PostgreSQL's date + interval:
 * a day past the end of the target month becomes its last day
 * (2024-02-29 + 12 months = 2025-02-28).
 */
export function addMonths(day: string, months: number): string {
  const m = DAY_RE.exec(day);
  if (!m) throw new Error(`Invalid date "${day}" (expected yyyy-mm-dd)`);
  const year = Number(m[1]);
  const month = Number(m[2]) - 1;
  const date = Number(m[3]);
  const check = new Date(Date.UTC(year, month, date));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month || check.getUTCDate() !== date) {
    throw new Error(`Invalid date "${day}"`);
  }
  const total = year * 12 + month + Math.trunc(months);
  const ty = Math.floor(total / 12);
  const tm = total - ty * 12;
  const lastDay = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  return `${pad(ty, 4)}-${pad(tm + 1)}-${pad(Math.min(date, lastDay))}`;
}

/**
 * When a closed dossier is due at the archive: end + 1 year, or + 3 months
 * for capital construction (xây dựng cơ bản). Same rule as
 * dossier_transfer_due in SQL.
 */
export function transferDueDate(endDate: string, isCapitalConstruction: boolean): string {
  return addMonths(endDate, isCapitalConstruction ? 3 : 12);
}

// ---------------------------------------------------------------- labels

/** 'Permanent (Vĩnh viễn)', '1 year', '10 years'; 'Not set' without a code. */
export function retentionLabel(code: Pick<RetentionCode, "years"> | null | undefined): string {
  if (!code) return "Not set";
  if (code.years == null) return "Permanent (Vĩnh viễn)";
  return code.years === 1 ? "1 year" : `${code.years} years`;
}

// ---------------------------------------------------------------- manifest

export type DossierManifestEntry = {
  /** position in the manifest (số thứ tự), 1-based, in chronological order */
  ordinal: number;
  notation: string | null;
  /** the document's date: issued date, else arrival date */
  date: string | null;
  subject: string;
  type: string | null;
};

export type DossierManifest = {
  code: string;
  title: string;
  retention: string;
  start_date: string | null;
  end_date: string | null;
  documents: DossierManifestEntry[];
};

type ManifestDossier = Pick<DossierRow, "code" | "title" | "start_date" | "end_date"> & {
  retention_years?: number | null;
  retention_code?: string | null;
};

/**
 * The dossier's table of contents (mục lục văn bản): documents in
 * chronological order (Phụ lục VI III.4.g), numbered from 1. Undated
 * documents follow the dated ones; ties keep the dossier order. Documents the
 * caller cannot read are listed as 'Restricted document' at the end.
 */
export function buildDossierManifest(
  dossier: ManifestDossier,
  documents: readonly DossierDocument[]
): DossierManifest {
  const dated = documents.map((doc) => ({
    doc,
    date: doc.readable ? doc.issued_date ?? doc.arrival_date ?? null : null,
  }));
  dated.sort((a, b) => {
    if (a.doc.readable !== b.doc.readable) return a.doc.readable ? -1 : 1;
    if (a.date !== b.date) {
      if (a.date === null) return 1;
      if (b.date === null) return -1;
      return a.date < b.date ? -1 : 1;
    }
    return a.doc.ordinal - b.doc.ordinal;
  });

  const hasRetention = dossier.retention_code != null || dossier.retention_years != null;
  return {
    code: dossier.code,
    title: dossier.title,
    retention: hasRetention ? retentionLabel({ years: dossier.retention_years ?? null }) : retentionLabel(null),
    start_date: dossier.start_date,
    end_date: dossier.end_date,
    documents: dated.map(({ doc, date }, index) =>
      doc.readable
        ? { ordinal: index + 1, notation: doc.notation, date, subject: doc.subject, type: doc.type_name }
        : { ordinal: index + 1, notation: null, date: null, subject: RESTRICTED_DOCUMENT_LABEL, type: null }
    ),
  };
}
