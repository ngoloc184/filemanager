import { createClient } from "@/lib/supabase/client";
import { getErrorMessage } from "@/lib/types/database";
import { flushNotificationPush } from "@/lib/services/notifications";
import type {
  DocAccess,
  DocField,
  DocFileKind,
  DocRegister,
  DocType,
  DocumentBundle,
  DocumentProfileInput,
  Direction,
  ExternalOrg,
  OpinionKind,
} from "@/lib/documents/types";

// Documents (Văn bản) core. Lookups and registers are RLS table selects;
// every write is an RPC from 202608280036_documents_core.sql. Mutations flush
// device push for the notifications they created (bell + Web Push).

export { listHolidays } from "@/lib/services/org";

/** Explains a missing migration instead of showing PostgREST's raw error. */
function documentsError(error: unknown): Error {
  const code = (error as { code?: string } | null)?.code;
  const message = getErrorMessage(error);
  if (
    code === "PGRST202" ||
    code === "PGRST205" ||
    /could not find the (function|table)/i.test(message)
  ) {
    return new Error(
      "Documents are not set up yet. Run migration 202608280036_documents_core.sql."
    );
  }
  return new Error(message);
}

// ---------------------------------------------------------------- documents

/** Creates a draft; incoming needs the clerk role. Returns the document id. */
export async function createDocument(
  direction: Direction,
  profile: DocumentProfileInput
): Promise<string> {
  const { data, error } = await createClient().rpc("create_document", {
    p_direction: direction,
    p_profile: profile,
  });
  if (error) throw documentsError(error);
  flushNotificationPush();
  return data as string;
}

/** Saves the given profile keys; the server ignores keys it does not accept. */
export async function updateDocumentProfile(
  id: string,
  profile: DocumentProfileInput
): Promise<void> {
  const { error } = await createClient().rpc("update_document_profile", {
    p_id: id,
    p_profile: profile,
  });
  if (error) throw documentsError(error);
  flushNotificationPush();
}

/** The caller's 'Documents' system folder (created at root when missing). */
export async function ensureDocumentFolder(): Promise<string> {
  const { data, error } = await createClient().rpc("ensure_document_folder");
  if (error) throw documentsError(error);
  flushNotificationPush();
  return data as string;
}

/** Links a file the caller administers; a new 'main' demotes the old one. */
export async function attachDocumentFile(
  documentId: string,
  fileId: string,
  kind: DocFileKind = "attachment"
): Promise<string> {
  const { data, error } = await createClient().rpc("attach_document_file", {
    p_document_id: documentId,
    p_file_id: fileId,
    p_kind: kind,
  });
  if (error) throw documentsError(error);
  flushNotificationPush();
  return data as string;
}

/** Unlinks a file (the file itself stays); frozen files cannot be detached. */
export async function detachDocumentFile(documentId: string, fileId: string): Promise<void> {
  const { error } = await createClient().rpc("detach_document_file", {
    p_document_id: documentId,
    p_file_id: fileId,
  });
  if (error) throw documentsError(error);
  flushNotificationPush();
}

/** Adds a processing opinion (ý kiến xử lý); returns its id. */
export async function addDocumentOpinion(
  documentId: string,
  kind: OpinionKind,
  body: string
): Promise<string> {
  const { data, error } = await createClient().rpc("add_document_opinion", {
    p_document_id: documentId,
    p_kind: kind,
    p_body: body,
  });
  if (error) throw documentsError(error);
  flushNotificationPush();
  return data as string;
}

/** Shares a document with a member of the same company (author or admin only). */
export async function grantDocumentAccess(
  documentId: string,
  userId: string,
  access: DocAccess
): Promise<void> {
  const { error } = await createClient().rpc("grant_document_access", {
    p_document_id: documentId,
    p_user_id: userId,
    p_access: access,
  });
  if (error) throw documentsError(error);
  flushNotificationPush();
}

export async function revokeDocumentAccess(documentId: string, userId: string): Promise<void> {
  const { error } = await createClient().rpc("revoke_document_access", {
    p_document_id: documentId,
    p_user_id: userId,
  });
  if (error) throw documentsError(error);
  flushNotificationPush();
}

/** Everything the document page shows; also logs a 'view' (at most hourly). */
export async function getDocument(id: string): Promise<DocumentBundle> {
  const { data, error } = await createClient().rpc("get_document", { p_id: id });
  if (error) throw documentsError(error);
  if (!data) throw new Error("Document not found");
  const raw = data as Partial<DocumentBundle> & Pick<DocumentBundle, "document" | "me">;
  // jsonb_agg of no rows is null: give the page arrays it can map over
  return {
    document: { ...raw.document, keywords: raw.document.keywords ?? [] },
    files: raw.files ?? [],
    assignments: raw.assignments ?? [],
    approval_steps: raw.approval_steps ?? [],
    opinions: raw.opinions ?? [],
    recipients: raw.recipients ?? [],
    grants: raw.grants ?? [],
    events: raw.events ?? [],
    related: raw.related ?? [],
    me: {
      ...raw.me,
      roles: raw.me?.roles ?? [],
      headed_department_ids: raw.me?.headed_department_ids ?? [],
      can_edit: raw.me?.can_edit === true,
    },
  };
}

/** Records a download or print in the document's access log. */
export async function logDocumentAccess(id: string, action: "download" | "print"): Promise<void> {
  const { error } = await createClient().rpc("log_document_access", {
    p_id: id,
    p_action: action,
  });
  if (error) throw documentsError(error);
  flushNotificationPush();
}

/** Deletes a draft (the author's, or an incoming draft by the clerk); files stay. */
export async function deleteDocument(id: string): Promise<void> {
  const { error } = await createClient().rpc("delete_document", { p_id: id });
  if (error) throw documentsError(error);
  flushNotificationPush();
}

// ---------------------------------------------------------------- lookups

/** Document types (loại văn bản) of the caller's company; active only by default. */
export async function listDocTypes(includeInactive = false): Promise<DocType[]> {
  let query = createClient().from("doc_types").select("*");
  if (!includeInactive) query = query.eq("active", true);
  const { data, error } = await query.order("sort_order").order("name");
  if (error) throw documentsError(error);
  return (data ?? []) as DocType[];
}

/** Fields (lĩnh vực); active only by default. */
export async function listDocFields(includeInactive = false): Promise<DocField[]> {
  let query = createClient().from("doc_fields").select("*");
  if (!includeInactive) query = query.eq("active", true);
  const { data, error } = await query.order("name");
  if (error) throw documentsError(error);
  return (data ?? []) as DocField[];
}

/** Outside organizations (cơ quan ban hành / nơi nhận); active only by default. */
export async function listExternalOrgs(includeInactive = false): Promise<ExternalOrg[]> {
  let query = createClient().from("external_orgs").select("*");
  if (!includeInactive) query = query.eq("active", true);
  const { data, error } = await query.order("name");
  if (error) throw documentsError(error);
  return (data ?? []) as ExternalOrg[];
}

/** Register books (sổ văn bản), newest year first; optionally one direction and year. */
export async function listRegisters(direction?: Direction | null, year?: number | null): Promise<DocRegister[]> {
  let query = createClient().from("doc_registers").select("*");
  if (direction) query = query.eq("direction", direction);
  if (year != null) query = query.eq("year", year);
  const { data, error } = await query.order("year", { ascending: false }).order("name");
  if (error) throw documentsError(error);
  return (data ?? []) as DocRegister[];
}
