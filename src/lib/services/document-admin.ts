import { createClient } from "@/lib/supabase/client";
import { getErrorMessage } from "@/lib/types/database";
import type {
  DocField,
  DocRegister,
  DocType,
  Direction,
  ExternalOrg,
  RegisterScope,
} from "@/lib/documents/types";
import type {
  IncomingRegisterEntry,
  OutgoingRegisterEntry,
} from "@/lib/documents/register-export";

// Documents administration: lookups (types, fields, external organizations),
// register books (sổ văn bản) and their roles, number previews and the
// register print data. Every write is an RPC from
// 202608280039_document_registers.sql; the server takes the company from the
// caller (new rows) or from the row itself (edits). Reads of the lookups and
// registers themselves are in services/documents.ts.

export type RegisterRole = "manager" | "follower";

/** A register role with the person's name (doc_register_roles + directory). */
export type RegisterRoleRow = {
  register_id: string;
  user_id: string;
  role: RegisterRole;
  display_name: string | null;
  email: string | null;
};

/** Omitted isCongVan / active / sortOrder / retention keep the stored values on edit. */
export type DocTypeInput = {
  id?: string | null;
  name: string;
  abbreviation: string;
  isCongVan?: boolean | null;
  active?: boolean | null;
  sortOrder?: number | null;
  /** '' clears it; omitted or null keeps the stored code */
  defaultRetentionCode?: string | null;
};

export type DocFieldInput = { id?: string | null; name: string; active?: boolean | null };

/** Blank code / email / address clear them. */
export type ExternalOrgInput = {
  id?: string | null;
  name: string;
  code?: string | null;
  email?: string | null;
  address?: string | null;
  active?: boolean | null;
};

/**
 * Omitted startNumber, scope, templates, isConfidential and allowedTypeIds
 * use the defaults when new (1, 'register', ...) and keep the stored values
 * on edit. Direction, year, scope and start
 * number cannot change once the register has handed out a number.
 */
export type DocRegisterInput = {
  id?: string | null;
  direction: Direction;
  name: string;
  year: number;
  startNumber?: number;
  scope?: RegisterScope;
  notationTemplate?: string | null;
  congVanTemplate?: string | null;
  isConfidential?: boolean | null;
  /** empty: every type is allowed */
  allowedTypeIds?: string[] | null;
};

export type RegisterEntryFilter = {
  /** yyyy-mm-dd: arrival date (incoming) or issue date */
  from?: string | null;
  to?: string | null;
  /** arrival number (incoming) or number */
  fromNumber?: number | null;
  toNumber?: number | null;
};

/** Explains a missing migration instead of showing PostgREST's raw error. */
function adminError(error: unknown): Error {
  const code = (error as { code?: string } | null)?.code;
  const message = getErrorMessage(error);
  if (
    code === "PGRST202" ||
    code === "PGRST205" ||
    /could not find the (function|table)/i.test(message)
  ) {
    return new Error(
      "Document administration is not set up yet. Run migration 202608280039_document_registers.sql."
    );
  }
  return new Error(message);
}

// ---------------------------------------------------------------- lookups

/** Adds or edits a document type (loại văn bản); company admins only. */
export async function upsertDocType(input: DocTypeInput): Promise<DocType> {
  const { data, error } = await createClient().rpc("upsert_doc_type", {
    p_id: input.id ?? null,
    p_name: input.name,
    p_abbreviation: input.abbreviation,
    p_is_cong_van: input.isCongVan ?? null,
    p_active: input.active ?? null,
    p_sort_order: input.sortOrder ?? null,
    p_default_retention_code: input.defaultRetentionCode ?? null,
  });
  if (error) throw adminError(error);
  return data as DocType;
}

/** Adds or edits a field (lĩnh vực); company admins only. */
export async function upsertDocField(input: DocFieldInput): Promise<DocField> {
  const { data, error } = await createClient().rpc("upsert_doc_field", {
    p_id: input.id ?? null,
    p_name: input.name,
    p_active: input.active ?? null,
  });
  if (error) throw adminError(error);
  return data as DocField;
}

/** Adds or edits an outside organization; company admins and clerks (Văn thư). */
export async function upsertExternalOrg(input: ExternalOrgInput): Promise<ExternalOrg> {
  const { data, error } = await createClient().rpc("upsert_external_org", {
    p_id: input.id ?? null,
    p_name: input.name,
    p_code: input.code ?? null,
    p_email: input.email ?? null,
    p_address: input.address ?? null,
    p_active: input.active ?? null,
  });
  if (error) throw adminError(error);
  return data as ExternalOrg;
}

// ---------------------------------------------------------------- registers

/** Creates or edits a register book (sổ văn bản); company admins only. */
export async function upsertDocRegister(input: DocRegisterInput): Promise<DocRegister> {
  const { data, error } = await createClient().rpc("upsert_doc_register", {
    p_id: input.id ?? null,
    p_direction: input.direction,
    p_name: input.name,
    p_year: input.year,
    p_start_number: input.startNumber ?? null,
    p_scope: input.scope ?? null,
    p_notation_template: input.notationTemplate ?? null,
    p_cong_van_template: input.congVanTemplate ?? null,
    p_is_confidential: input.isConfidential ?? null,
    p_allowed_type_ids: input.allowedTypeIds ?? null,
  });
  if (error) throw adminError(error);
  return data as DocRegister;
}

/** A closed register hands out no more numbers. */
export async function closeDocRegister(id: string): Promise<DocRegister> {
  const { data, error } = await createClient().rpc("close_doc_register", { p_id: id });
  if (error) throw adminError(error);
  return data as DocRegister;
}

export async function reopenDocRegister(id: string): Promise<DocRegister> {
  const { data, error } = await createClient().rpc("reopen_doc_register", { p_id: id });
  if (error) throw adminError(error);
  return data as DocRegister;
}

/** Only a register no document uses can be deleted; close it otherwise. */
export async function deleteDocRegister(id: string): Promise<void> {
  const { error } = await createClient().rpc("delete_doc_register", { p_id: id });
  if (error) throw adminError(error);
}

/** Gives an active member a register role; null removes it. */
export async function setRegisterRole(
  registerId: string,
  userId: string,
  role: RegisterRole | null
): Promise<void> {
  const { error } = await createClient().rpc("set_register_role", {
    p_register_id: registerId,
    p_user_id: userId,
    p_role: role,
  });
  if (error) throw adminError(error);
}

/** Copies last year's open registers (settings and roles) into `year`; returns how many. */
export async function openNextYearRegisters(year: number): Promise<number> {
  const { data, error } = await createClient().rpc("open_next_year_registers", { p_year: year });
  if (error) throw adminError(error);
  return Number(data ?? 0);
}

/** Managers and followers of a register with their names, managers first. */
export async function listRegisterRoles(registerId: string): Promise<RegisterRoleRow[]> {
  const supabase = createClient();
  // user_profiles is not readable across users: names come from the directory RPC
  const [roles, members] = await Promise.all([
    supabase.from("doc_register_roles").select("register_id, user_id, role").eq("register_id", registerId),
    supabase.rpc("list_org_members", { p_query: null, p_include_inactive: true }),
  ]);
  if (roles.error) throw adminError(roles.error);
  if (members.error) throw adminError(members.error);

  const people = new Map(
    ((members.data ?? []) as { user_id: string; display_name: string | null; email: string | null }[]).map(
      (m) => [m.user_id, m]
    )
  );
  return ((roles.data ?? []) as { register_id: string; user_id: string; role: RegisterRole }[])
    .map((r) => ({
      ...r,
      display_name: people.get(r.user_id)?.display_name ?? null,
      email: people.get(r.user_id)?.email ?? null,
    }))
    .sort(
      (a, b) =>
        (a.role === b.role ? 0 : a.role === "manager" ? -1 : 1) ||
        (a.display_name || a.email || "").localeCompare(b.display_name || b.email || "", "vi")
    );
}

// ---------------------------------------------------------------- numbers and entries

/** The next number the register would hand out (a preview; nothing is taken). */
export async function peekNextNumber(registerId: string, docTypeId?: string | null): Promise<number> {
  const { data, error } = await createClient().rpc("peek_next_number", {
    p_register_id: registerId,
    p_doc_type_id: docTypeId ?? null,
  });
  if (error) throw adminError(error);
  return Number(data);
}

/**
 * The rows of a printed register (Decree 30 Phụ lục IV), in number order.
 * Rows the caller cannot read have readable false and subject
 * 'Restricted document'.
 */
export async function listRegisterEntries(
  registerId: string,
  filter: RegisterEntryFilter = {}
): Promise<IncomingRegisterEntry[] | OutgoingRegisterEntry[]> {
  const { data, error } = await createClient().rpc("list_register_entries", {
    p_register_id: registerId,
    p_from: filter.from || null,
    p_to: filter.to || null,
    p_from_number: filter.fromNumber ?? null,
    p_to_number: filter.toNumber ?? null,
  });
  if (error) throw adminError(error);
  return (Array.isArray(data) ? data : []) as IncomingRegisterEntry[] | OutgoingRegisterEntry[];
}
