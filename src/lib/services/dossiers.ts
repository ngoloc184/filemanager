import { createClient } from "@/lib/supabase/client";
import { getErrorMessage } from "@/lib/types/database";
import type {
  DocumentDossier,
  DossierBundle,
  DossierListItem,
  DossierRow,
  DossierStatus,
  RetentionCode,
} from "@/lib/documents/dossiers";

// Dossiers (hồ sơ) and the retention catalog. Retention codes are an RLS
// table select; everything else is an RPC from
// 202608280043_dossiers_retention.sql (none of them notify anyone).

/** Explains a missing migration instead of showing PostgREST's raw error. */
function dossiersError(error: unknown): Error {
  const code = (error as { code?: string } | null)?.code;
  const message = getErrorMessage(error);
  if (
    code === "PGRST202" ||
    code === "PGRST205" ||
    /could not find the (function|table)/i.test(message)
  ) {
    return new Error(
      "Dossiers are not set up yet. Run migration 202608280043_dossiers_retention.sql."
    );
  }
  return new Error(message);
}

// ---------------------------------------------------------------- retention catalog

/** Retention codes (thời hạn bảo quản) of the caller's company, in catalog order. */
export async function listRetentionCodes(): Promise<RetentionCode[]> {
  const { data, error } = await createClient()
    .from("retention_codes")
    .select("*")
    .order("sort_order")
    .order("code");
  if (error) throw dossiersError(error);
  return (data ?? []) as RetentionCode[];
}

export type RetentionCodeInput = {
  /** null adds a new code to the caller's company */
  id: string | null;
  /** 1–10 letters or digits; upper-cased by the server */
  code: string;
  label: string;
  /** 1–100, or null for permanent (Vĩnh viễn) */
  years: number | null;
  sort_order?: number | null;
};

/** Adds or edits a retention code (company admins only). */
export async function upsertRetentionCode(input: RetentionCodeInput): Promise<RetentionCode> {
  const { data, error } = await createClient().rpc("upsert_retention_code", {
    p_id: input.id,
    p_code: input.code,
    p_label: input.label,
    p_years: input.years,
    p_sort_order: input.sort_order ?? null,
  });
  if (error) throw dossiersError(error);
  return data as RetentionCode;
}

// ---------------------------------------------------------------- dossiers

export type CreateDossierInput = {
  year: number;
  code: string;
  title: string;
  /** null = the caller's department */
  department_id: string | null;
  retention_code_id: string | null;
  description?: string | null;
};

/** Opens a dossier in the caller's company; the caller owns it. */
export async function createDossier(input: CreateDossierInput): Promise<DossierRow> {
  const { data, error } = await createClient().rpc("create_dossier", {
    p_year: input.year,
    p_code: input.code,
    p_title: input.title,
    p_department_id: input.department_id,
    p_retention_code_id: input.retention_code_id,
    p_description: input.description ?? null,
  });
  if (error) throw dossiersError(error);
  return data as DossierRow;
}

export type UpdateDossierInput = {
  title: string;
  retention_code_id: string | null;
  department_id: string | null;
  description: string | null;
  /** null keeps the current value */
  is_capital_construction: boolean | null;
};

/**
 * Saves an open dossier (owner, clerk or admin). Every field is the new value:
 * null clears it, except is_capital_construction where null keeps it.
 */
export async function updateDossier(id: string, input: UpdateDossierInput): Promise<DossierRow> {
  const { data, error } = await createClient().rpc("update_dossier", {
    p_id: id,
    p_title: input.title,
    p_retention_code_id: input.retention_code_id,
    p_department_id: input.department_id,
    p_description: input.description,
    p_is_capital_construction: input.is_capital_construction,
  });
  if (error) throw dossiersError(error);
  return data as DossierRow;
}

/** Files a readable document in an open dossier; returns its ordinal. */
export async function addDocumentToDossier(dossierId: string, documentId: string): Promise<number> {
  const { data, error } = await createClient().rpc("add_document_to_dossier", {
    p_dossier_id: dossierId,
    p_document_id: documentId,
  });
  if (error) throw dossiersError(error);
  return data as number;
}

/** Takes a document out of an open dossier that is not on legal hold. */
export async function removeDocumentFromDossier(dossierId: string, documentId: string): Promise<void> {
  const { error } = await createClient().rpc("remove_document_from_dossier", {
    p_dossier_id: dossierId,
    p_document_id: documentId,
  });
  if (error) throw dossiersError(error);
}

/** Closes an open dossier; the end date defaults to today in the company's time zone. */
export async function closeDossier(id: string, endDate?: string | null): Promise<DossierRow> {
  const { data, error } = await createClient().rpc("close_dossier", {
    p_id: id,
    p_end_date: endDate ?? null,
  });
  if (error) throw dossiersError(error);
  return data as DossierRow;
}

/** Reopens a closed dossier (company admins only). */
export async function reopenDossier(id: string): Promise<DossierRow> {
  const { data, error } = await createClient().rpc("reopen_dossier", { p_id: id });
  if (error) throw dossiersError(error);
  return data as DossierRow;
}

/** Transfers a closed dossier to the archive (nộp lưu); clerk or admin. */
export async function transferDossier(id: string): Promise<DossierRow> {
  const { data, error } = await createClient().rpc("transfer_dossier", { p_id: id });
  if (error) throw dossiersError(error);
  return data as DossierRow;
}

/** Puts a dossier on legal hold or lifts it (company admins only). */
export async function setDossierLegalHold(id: string, hold: boolean): Promise<DossierRow> {
  const { data, error } = await createClient().rpc("set_dossier_legal_hold", {
    p_id: id,
    p_hold: hold,
  });
  if (error) throw dossiersError(error);
  return data as DossierRow;
}

export type DossierFilters = {
  year?: number | null;
  status?: DossierStatus | null;
  /** matches code or title, accents ignored */
  q?: string | null;
};

/** Dossiers of the caller's company that the caller can read. */
export async function listDossiers(filters: DossierFilters = {}): Promise<DossierListItem[]> {
  const { data, error } = await createClient().rpc("list_dossiers", {
    p_year: filters.year ?? null,
    p_status: filters.status ?? null,
    p_q: filters.q?.trim() || null,
  });
  if (error) throw dossiersError(error);
  return (data ?? []) as DossierListItem[];
}

/** The dossier page; unreadable documents carry only their id and ordinal. */
export async function getDossier(id: string): Promise<DossierBundle> {
  const { data, error } = await createClient().rpc("get_dossier", { p_id: id });
  if (error) throw dossiersError(error);
  if (!data) throw new Error("Dossier not found");
  const raw = data as Partial<DossierBundle> & Pick<DossierBundle, "dossier">;
  return {
    dossier: {
      ...raw.dossier,
      can_manage: raw.dossier.can_manage === true,
      is_admin: raw.dossier.is_admin === true,
      is_clerk: raw.dossier.is_clerk === true,
    },
    documents: raw.documents ?? [],
  };
}

/** Closed dossiers due at the archive within `days` (or overdue); clerk, leader or admin. */
export async function listDossiersDueForTransfer(days = 30): Promise<DossierListItem[]> {
  const { data, error } = await createClient().rpc("dossiers_due_for_transfer", { p_days: days });
  if (error) throw dossiersError(error);
  return (data ?? []) as DossierListItem[];
}

/** The readable dossiers that hold a document. */
export async function listDocumentDossiers(documentId: string): Promise<DocumentDossier[]> {
  const { data, error } = await createClient().rpc("document_dossiers", {
    p_document_id: documentId,
  });
  if (error) throw dossiersError(error);
  return (data ?? []) as DocumentDossier[];
}
