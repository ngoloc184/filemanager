// Create / edit / register form rules for documents. Pure: no React or
// Supabase imports, so they run in node:test. The server repeats every check
// (doc_clean_profile in 202608280036_documents_core.sql and register_incoming
// in 202608280040_documents_incoming.sql); these only give fast feedback.

import type {
  Confidentiality,
  Direction,
  DocType,
  DocumentDetail,
  DocumentProfileInput,
  ExternalOrg,
  Urgency,
} from "./types.ts";

export const MAX_SUBJECT_LENGTH = 500;
export const MAX_DESCRIPTION_LENGTH = 2000;
export const MAX_ISSUING_ORG_LENGTH = 500;
export const MAX_NOTATION_LENGTH = 100;
export const MAX_SIGNER_LENGTH = 200;
export const MAX_KEYWORDS = 10;
export const MAX_KEYWORD_LENGTH = 50;
export const MAX_PAGE_COUNT = 1_000_000;
export const MAX_DUPLICATE_REASON_LENGTH = 2000;

/**
 * What the form edits. Text inputs keep plain strings ('' = empty); ids are ''
 * when nothing is picked. Dates are 'yyyy-mm-dd' (the date input's value).
 */
export type DocumentFormValues = {
  docTypeId: string;
  fieldId: string;
  subject: string;
  urgency: Urgency;
  confidentiality: Confidentiality;
  dueDate: string;
  keywords: string[];
  description: string;
  /** outgoing / internal only */
  draftingDepartmentId: string;
  // incoming only: sender details (nơi gửi)
  issuingOrgName: string;
  externalOrgId: string;
  notation: string;
  issuedDate: string;
  arrivalDate: string;
  signerName: string;
  signerPosition: string;
  pageCount: string;
};

/** Field keys errors are reported under; mainFile is the Files section. */
export type DocumentFormField = keyof DocumentFormValues | "mainFile";
export type DocumentFormErrors = Partial<Record<DocumentFormField, string>>;

export type ValidateOptions = {
  /** incoming create with 'Register now (Vào sổ)' ticked */
  registerNow?: boolean;
  /** a main file is picked (or already attached) */
  hasMainFile?: boolean;
};

export function emptyDocumentForm(defaults: Partial<DocumentFormValues> = {}): DocumentFormValues {
  return {
    docTypeId: "",
    fieldId: "",
    subject: "",
    urgency: "normal",
    confidentiality: "normal",
    dueDate: "",
    keywords: [],
    description: "",
    draftingDepartmentId: "",
    issuingOrgName: "",
    externalOrgId: "",
    notation: "",
    issuedDate: "",
    arrivalDate: "",
    signerName: "",
    signerPosition: "",
    pageCount: "",
    ...defaults,
  };
}

/** The form values of a stored document (edit mode). */
export function formValuesFromDocument(
  doc: Pick<
    DocumentDetail,
    | "doc_type_id"
    | "field_id"
    | "subject"
    | "urgency"
    | "confidentiality"
    | "due_date"
    | "keywords"
    | "description"
    | "drafting_department_id"
    | "issuing_org_name"
    | "external_org_id"
    | "notation"
    | "issued_date"
    | "arrival_date"
    | "signer_name"
    | "signer_position"
    | "page_count"
  >
): DocumentFormValues {
  return {
    docTypeId: doc.doc_type_id ?? "",
    fieldId: doc.field_id ?? "",
    subject: doc.subject ?? "",
    urgency: doc.urgency ?? "normal",
    confidentiality: doc.confidentiality ?? "normal",
    dueDate: dayOnly(doc.due_date),
    keywords: [...(doc.keywords ?? [])],
    description: doc.description ?? "",
    draftingDepartmentId: doc.drafting_department_id ?? "",
    issuingOrgName: doc.issuing_org_name ?? "",
    externalOrgId: doc.external_org_id ?? "",
    notation: doc.notation ?? "",
    issuedDate: dayOnly(doc.issued_date),
    arrivalDate: dayOnly(doc.arrival_date),
    signerName: doc.signer_name ?? "",
    signerPosition: doc.signer_position ?? "",
    pageCount: doc.page_count == null ? "" : String(doc.page_count),
  };
}

function dayOnly(value: string | null | undefined): string {
  return value ? value.slice(0, 10) : "";
}

const ISO_DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const VN_DAY_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;

/**
 * 'yyyy-mm-dd' or 'dd/mm/yyyy' → 'yyyy-mm-dd'; '' → ''; anything else
 * (including impossible dates such as 2026-02-30) → null.
 */
export function toIsoDay(value: string | null | undefined): string | null {
  const s = (value ?? "").trim();
  if (!s) return "";
  let y: number, m: number, d: number;
  const iso = ISO_DAY_RE.exec(s);
  const vn = iso ? null : VN_DAY_RE.exec(s);
  if (iso) {
    [y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  } else if (vn) {
    [y, m, d] = [Number(vn[3]), Number(vn[2]), Number(vn[1])];
  } else {
    return null;
  }
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/**
 * Sender's number and notation (số, ký hiệu) as registers print it: trimmed,
 * spaces around '/' and '-' removed, other runs of spaces collapsed, letters
 * upper-cased (đ → Đ). " 123 / ubnd - vp " → "123/UBND-VP".
 */
export function normalizeNotation(s: string | null | undefined): string {
  return (s ?? "")
    .trim()
    .replace(/\s*([/-])\s*/g, "$1")
    .replace(/\s+/g, " ")
    .toUpperCase();
}

/** Trims, drops blanks and duplicates (case-insensitive, first kept). Does not cap. */
export function cleanKeywords(keywords: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of keywords) {
    const k = raw.trim().replace(/\s+/g, " ");
    if (!k) continue;
    const key = k.toLocaleLowerCase("vi");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(k);
  }
  return out;
}

/**
 * Adds what was typed in the keyword chip input (commas separate several) to
 * `current`, deduped and capped at MAX_KEYWORDS.
 */
export function addKeywords(current: readonly string[], typed: string): string[] {
  return cleanKeywords([...current, ...typed.split(",")]).slice(0, MAX_KEYWORDS);
}

function parsePageCount(value: string): number | null | undefined {
  const s = value.trim();
  if (!s) return undefined;
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return n >= 1 && n <= MAX_PAGE_COUNT ? n : null;
}

/** Inline errors by field; {} when the form can be saved. */
export function validateDocumentForm(
  values: DocumentFormValues,
  direction: Direction,
  options: ValidateOptions = {}
): DocumentFormErrors {
  const errors: DocumentFormErrors = {};
  const incoming = direction === "incoming";

  const subject = values.subject.trim();
  if (!subject) errors.subject = "Enter the subject (trích yếu)";
  else if (subject.length > MAX_SUBJECT_LENGTH) {
    errors.subject = `Subject must be at most ${MAX_SUBJECT_LENGTH} characters`;
  }

  if (!values.docTypeId) errors.docTypeId = "Choose the document type";

  if (values.description.trim().length > MAX_DESCRIPTION_LENGTH) {
    errors.description = `Description must be at most ${MAX_DESCRIPTION_LENGTH} characters`;
  }

  const keywords = cleanKeywords(values.keywords);
  if (keywords.length > MAX_KEYWORDS) errors.keywords = `At most ${MAX_KEYWORDS} keywords`;
  else if (keywords.some((k) => k.length > MAX_KEYWORD_LENGTH)) {
    errors.keywords = `Each keyword must be at most ${MAX_KEYWORD_LENGTH} characters`;
  }

  const dueDate = toIsoDay(values.dueDate);
  if (dueDate === null) errors.dueDate = "Enter a valid date";

  if (incoming) {
    const issuedDate = toIsoDay(values.issuedDate);
    const arrivalDate = toIsoDay(values.arrivalDate);
    if (issuedDate === null) errors.issuedDate = "Enter a valid date";
    if (arrivalDate === null) errors.arrivalDate = "Enter a valid date";
    if (issuedDate && arrivalDate && arrivalDate < issuedDate) {
      errors.arrivalDate = "The arrival date cannot be before the document date";
    }
    if (issuedDate && dueDate && dueDate < issuedDate) {
      errors.dueDate = "The due date cannot be before the document date";
    }

    const issuingOrg = values.issuingOrgName.trim();
    if (issuingOrg.length > MAX_ISSUING_ORG_LENGTH) {
      errors.issuingOrgName = `Issuing organisation must be at most ${MAX_ISSUING_ORG_LENGTH} characters`;
    } else if (options.registerNow && !issuingOrg) {
      errors.issuingOrgName = "Enter the issuing organisation";
    }

    const notation = normalizeNotation(values.notation);
    if (notation.length > MAX_NOTATION_LENGTH) {
      errors.notation = `Number/notation must be at most ${MAX_NOTATION_LENGTH} characters`;
    } else if (options.registerNow && !notation) {
      errors.notation = "Enter the number and notation (số, ký hiệu)";
    }

    if (values.signerName.trim().length > MAX_SIGNER_LENGTH) {
      errors.signerName = `Signer name must be at most ${MAX_SIGNER_LENGTH} characters`;
    }
    if (values.signerPosition.trim().length > MAX_SIGNER_LENGTH) {
      errors.signerPosition = `Signer position must be at most ${MAX_SIGNER_LENGTH} characters`;
    }
    if (parsePageCount(values.pageCount) === null) {
      errors.pageCount = "Pages must be a whole number from 1";
    }

    if (options.registerNow && !options.hasMainFile) errors.mainFile = "Attach the main document";
  }

  return errors;
}

/** True when validateDocumentForm found nothing. */
export function isFormValid(errors: DocumentFormErrors): boolean {
  return Object.keys(errors).length === 0;
}

/**
 * The create_document / update_document_profile JSON for `values`. Empty
 * strings are left out, dates are 'yyyy-mm-dd', keywords trimmed and deduped,
 * the notation normalised. Sender fields only for incoming; the drafting
 * department only for outgoing / internal. Unparseable dates and page counts
 * are left out (validateDocumentForm reports them).
 */
export function toProfilePayload(values: DocumentFormValues, direction: Direction): DocumentProfileInput {
  const out: DocumentProfileInput = {};
  const text = (v: string) => {
    const s = v.trim();
    return s ? s : undefined;
  };
  const day = (v: string) => toIsoDay(v) || undefined;

  const subject = text(values.subject);
  if (subject) out.subject = subject;
  if (values.docTypeId) out.doc_type_id = values.docTypeId;
  if (values.fieldId) out.field_id = values.fieldId;
  out.urgency = values.urgency;
  out.confidentiality = values.confidentiality;
  const due = day(values.dueDate);
  if (due) out.due_date = due;
  const keywords = cleanKeywords(values.keywords);
  if (keywords.length) out.keywords = keywords;
  const description = text(values.description);
  if (description) out.description = description;

  if (direction === "incoming") {
    const issuingOrg = text(values.issuingOrgName);
    if (issuingOrg) out.issuing_org_name = issuingOrg;
    if (values.externalOrgId) out.external_org_id = values.externalOrgId;
    const notation = normalizeNotation(values.notation);
    if (notation) out.notation = notation;
    const issued = day(values.issuedDate);
    if (issued) out.issued_date = issued;
    const arrival = day(values.arrivalDate);
    if (arrival) out.arrival_date = arrival;
    const signerName = text(values.signerName);
    if (signerName) out.signer_name = signerName;
    const signerPosition = text(values.signerPosition);
    if (signerPosition) out.signer_position = signerPosition;
    const pages = parsePageCount(values.pageCount);
    if (pages != null) out.page_count = pages;
  } else if (values.draftingDepartmentId) {
    out.drafting_department_id = values.draftingDepartmentId;
  }
  return out;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => v === b[i]);
  }
  return a === b;
}

/**
 * The keys of `after` that differ from `before` (two toProfilePayload
 * results). A key `before` had and `after` lacks was cleared: it is sent as
 * null ([] for keywords) so the server clears it too.
 */
export function changedFields(before: DocumentProfileInput, after: DocumentProfileInput): DocumentProfileInput {
  const out: Record<string, unknown> = {};
  const b = before as Record<string, unknown>;
  const a = after as Record<string, unknown>;
  for (const key of new Set([...Object.keys(b), ...Object.keys(a)])) {
    const next = key in a ? a[key] : key === "keywords" ? [] : null;
    const prev = key in b ? b[key] : key === "keywords" ? [] : null;
    if (!sameValue(prev, next)) out[key] = next;
  }
  return out as DocumentProfileInput;
}

/** True when the edited values differ from where the form started. */
export function isFormDirty(initial: DocumentFormValues, current: DocumentFormValues): boolean {
  return (Object.keys(initial) as (keyof DocumentFormValues)[]).some(
    (key) => !sameValue(initial[key], current[key])
  );
}

/** Active types, công văn first, then sort order and name. `keepId` stays even when inactive (edit). */
export function sortDocTypes<T extends Pick<DocType, "id" | "name" | "is_cong_van" | "active" | "sort_order">>(
  types: readonly T[],
  keepId?: string | null
): T[] {
  return types
    .filter((t) => t.active || t.id === keepId)
    .sort(
      (a, b) =>
        Number(b.is_cong_van) - Number(a.is_cong_van) ||
        a.sort_order - b.sort_order ||
        a.name.localeCompare(b.name, "vi")
    );
}

/** Lower-case, accents removed, đ → d: "Ủy ban Đồng Nai" → "uy ban dong nai". */
export function foldText(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * External organizations matching `query` by name or code, ignoring case and
 * accents: names that start with it first, then other matches, by name.
 * An empty query returns the first `limit` by name.
 */
export function matchExternalOrgs<T extends Pick<ExternalOrg, "name" | "code">>(
  orgs: readonly T[],
  query: string,
  limit = 8
): T[] {
  const q = foldText(query);
  const scored: { org: T; rank: number }[] = [];
  for (const org of orgs) {
    const name = foldText(org.name);
    const code = foldText(org.code ?? "");
    let rank: number;
    if (!q) rank = 0;
    else if (name.startsWith(q) || (code && code.startsWith(q))) rank = 0;
    else if (name.includes(q) || (code && code.includes(q))) rank = 1;
    else continue;
    scored.push({ org, rank });
  }
  return scored
    .sort((a, b) => a.rank - b.rank || a.org.name.localeCompare(b.org.name, "vi"))
    .slice(0, limit)
    .map((s) => s.org);
}

/**
 * The external organization named exactly `name` (case and extra spaces
 * ignored, accents kept: "Sở Tài chính" is not "Sở Tài chinh"), if any.
 */
export function findExternalOrgByName<T extends Pick<ExternalOrg, "name">>(
  orgs: readonly T[],
  name: string
): T | null {
  const key = (s: string) => s.trim().replace(/\s+/g, " ").toLocaleLowerCase("vi");
  const q = key(name);
  if (!q) return null;
  return orgs.find((o) => key(o.name) === q) ?? null;
}

/** Label of the primary button. */
export function submitLabel(mode: "create" | "edit", direction: Direction, registerNow: boolean): string {
  if (mode === "edit") return "Save changes";
  return direction === "incoming" && registerNow ? "Save and register" : "Save draft";
}
