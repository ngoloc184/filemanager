import { createClient } from "@/lib/supabase/client";
import { getErrorMessage } from "@/lib/types/database";
import { flushNotificationPush } from "@/lib/services/notifications";
import type { SignerAuthority } from "@/lib/documents/types";
import type {
  ApprovalChainStepInput,
  FollowUpKind,
  IssueRecipientInput,
  IssueResult,
} from "@/lib/documents/outgoing";

// Outgoing and internal documents (văn bản đi / nội bộ): approval chain,
// sign, issue, recall and follow-ups. Every call is an RPC from
// 202608280041_documents_outgoing.sql and flushes device push for the
// notifications it created (bell + Web Push).

/** Explains a missing migration instead of showing PostgREST's raw error. */
function outgoingError(error: unknown): Error {
  const code = (error as { code?: string } | null)?.code;
  const message = getErrorMessage(error);
  if (code === "PGRST202" || /could not find the function/i.test(message)) {
    return new Error(
      "The outgoing documents workflow is not set up yet. Run migration 202608280041_documents_outgoing.sql."
    );
  }
  return new Error(message);
}

async function call<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await createClient().rpc(fn, args);
  if (error) throw outgoingError(error);
  flushNotificationPush();
  return data as T;
}

/** Replaces the draft's approval chain (author only); returns how many steps. */
export async function setApprovalChain(
  documentId: string,
  steps: ApprovalChainStepInput[]
): Promise<number> {
  return call<number>("set_approval_chain", { p_document_id: documentId, p_steps: steps });
}

/** Sends the draft to its first approvers and locks its files. */
export async function submitForApproval(documentId: string): Promise<void> {
  await call<null>("submit_for_approval", { p_document_id: documentId });
}

/** Approves the caller's review / format check / consult step. */
export async function approveStep(documentId: string, comment?: string | null): Promise<void> {
  await call<null>("approve_step", { p_document_id: documentId, p_comment: comment?.trim() || null });
}

/** Sends it back to the author as a new revision; the comment is required. */
export async function returnDocument(documentId: string, comment: string): Promise<void> {
  await call<null>("return_document", { p_document_id: documentId, p_comment: comment });
}

/** Rejects it for good (Từ chối). */
export async function rejectDocument(documentId: string, comment?: string | null): Promise<void> {
  await call<null>("reject_document", { p_document_id: documentId, p_comment: comment?.trim() || null });
}

/**
 * In-app e-approval by the signer of the last step. Records signer, authority
 * and the main file checksum; it is not a digital signature (chữ ký số).
 */
export async function signDocument(
  documentId: string,
  authority: SignerAuthority = "",
  comment?: string | null
): Promise<void> {
  await call<null>("sign_document", {
    p_document_id: documentId,
    p_authority: authority,
    p_comment: comment?.trim() || null,
  });
}

/** Clerk only: numbers, freezes and distributes a signed document. */
export async function issueDocument(
  documentId: string,
  registerId: string,
  recipients: IssueRecipientInput[],
  manualNumber?: number | null
): Promise<IssueResult> {
  const data = await call<IssueResult | null>("issue_document", {
    p_document_id: documentId,
    p_register_id: registerId,
    p_recipients: recipients,
    p_manual_number: manualNumber ?? null,
  });
  if (!data) throw new Error("The document was not issued");
  return { number: Number(data.number), notation: String(data.notation) };
}

/** Clerk or leader: recalls an issued document; the reason is required. */
export async function recallDocument(documentId: string, reason: string): Promise<void> {
  await call<null>("recall_document", { p_document_id: documentId, p_reason: reason });
}

/** The author withdraws a document that is not signed yet. */
export async function withdrawDocument(documentId: string): Promise<void> {
  await call<null>("withdraw_document", { p_document_id: documentId });
}

/** Starts a reply, replacement or correction draft; returns the new document id. */
export async function createFollowUp(sourceId: string, kind: FollowUpKind): Promise<string> {
  return call<string>("create_follow_up", { p_source_id: sourceId, p_kind: kind });
}
