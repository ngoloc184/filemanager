import { createClient } from "@/lib/supabase/client";
import { getErrorMessage } from "@/lib/types/database";
import { flushNotificationPush } from "@/lib/services/notifications";
import type {
  AssignmentItemInput,
  DuplicateCandidate,
  RegisterIncomingResult,
} from "@/lib/documents/incoming";

// Incoming documents (Văn bản đến) workflow: one wrapper per RPC of
// 202608280040_documents_incoming.sql. Every mutation flushes device push for
// the notifications it created (bell + Web Push).

/** Explains a missing migration instead of showing PostgREST's raw error. */
function incomingError(error: unknown): Error {
  const code = (error as { code?: string } | null)?.code;
  const message = getErrorMessage(error);
  if (code === "PGRST202" || /could not find the function/i.test(message)) {
    return new Error(
      "The incoming documents workflow is not set up yet. Run migration 202608280040_documents_incoming.sql."
    );
  }
  return new Error(message);
}

/**
 * Registers a draft in an incoming register (vào sổ). When the same document
 * may already be registered and no reason is given, nothing changes and the
 * possible duplicates come back (ok: false); pass a reason to register anyway.
 */
export async function registerIncoming(
  documentId: string,
  registerId: string,
  duplicateReason?: string | null
): Promise<RegisterIncomingResult> {
  const { data, error } = await createClient().rpc("register_incoming", {
    p_document_id: documentId,
    p_register_id: registerId,
    p_duplicate_reason: duplicateReason?.trim() || null,
  });
  if (error) throw incomingError(error);
  flushNotificationPush();
  const raw = (data ?? {}) as {
    ok?: boolean;
    arrival_number?: number | null;
    duplicates?: DuplicateCandidate[] | null;
  };
  return raw.ok
    ? { ok: true, arrival_number: raw.arrival_number ?? undefined }
    : { ok: false, duplicates: raw.duplicates ?? [] };
}

/** Presents a registered document to a leader or department head (trình). */
export async function submitIncoming(
  documentId: string,
  toUserId: string,
  note?: string | null
): Promise<void> {
  const { error } = await createClient().rpc("submit_incoming", {
    p_document_id: documentId,
    p_to_user_id: toUserId,
    p_note: note?.trim() || null,
  });
  if (error) throw incomingError(error);
  flushNotificationPush();
}

/**
 * Assigns lead (Chủ trì) / support (Phối hợp) / info (Để biết); with a parent
 * assignment it sub-assigns inside a department. Returns how many were added.
 */
export async function assignDocument(
  documentId: string,
  items: readonly AssignmentItemInput[],
  options: { parentAssignmentId?: string | null; instruction?: string | null } = {}
): Promise<number> {
  const { data, error } = await createClient().rpc("assign_document", {
    p_document_id: documentId,
    p_items: items.map((item) => ({
      ...(item.user_id ? { user_id: item.user_id } : {}),
      ...(item.department_id ? { department_id: item.department_id } : {}),
      role: item.role,
      ...(item.due_date ? { due_date: item.due_date } : {}),
      ...(item.instruction?.trim() ? { instruction: item.instruction.trim() } : {}),
    })),
    p_parent_assignment_id: options.parentAssignmentId ?? null,
    p_instruction: options.instruction?.trim() || null,
  });
  if (error) throw incomingError(error);
  flushNotificationPush();
  return (data as number | null) ?? 0;
}

/** Marks the caller's pending assignments on a document (any direction) as seen. */
export async function markMyAssignmentsSeen(documentId: string): Promise<number> {
  const { data, error } = await createClient().rpc("mark_my_assignments_seen", {
    p_document_id: documentId,
  });
  if (error) throw incomingError(error);
  flushNotificationPush();
  return (data as number | null) ?? 0;
}

/**
 * Moves the caller's assignment on: in_progress, done (a result is required
 * for lead/support) or returned (a reason is required).
 */
export async function updateAssignment(
  assignmentId: string,
  status: "in_progress" | "done" | "returned",
  result?: string | null
): Promise<void> {
  const { error } = await createClient().rpc("update_assignment", {
    p_assignment_id: assignmentId,
    p_status: status,
    p_result: result?.trim() || null,
  });
  if (error) throw incomingError(error);
  flushNotificationPush();
}

/** Takes back an assignment nobody has opened yet (and everything under it). */
export async function revokeAssignment(assignmentId: string): Promise<void> {
  const { error } = await createClient().rpc("revoke_assignment", { p_assignment_id: assignmentId });
  if (error) throw incomingError(error);
  flushNotificationPush();
}

/** Completes a document in progress (the lead, the leader it was presented to, or a leader). */
export async function completeDocument(documentId: string, result?: string | null): Promise<void> {
  const { error } = await createClient().rpc("complete_document", {
    p_document_id: documentId,
    p_result: result?.trim() || null,
  });
  if (error) throw incomingError(error);
  flushNotificationPush();
}

/** The leader sends a presented document back to the clerk. */
export async function returnToClerk(documentId: string, reason: string): Promise<void> {
  const { error } = await createClient().rpc("return_to_clerk", {
    p_document_id: documentId,
    p_reason: reason.trim(),
  });
  if (error) throw incomingError(error);
  flushNotificationPush();
}

/** Cancels a draft or registered incoming document; its arrival number is not reused. */
export async function cancelIncoming(documentId: string, reason: string): Promise<void> {
  const { error } = await createClient().rpc("cancel_incoming", {
    p_document_id: documentId,
    p_reason: reason.trim(),
  });
  if (error) throw incomingError(error);
  flushNotificationPush();
}

/** A leader reopens a completed document. */
export async function reopenDocument(documentId: string, reason: string): Promise<void> {
  const { error } = await createClient().rpc("reopen_document", {
    p_document_id: documentId,
    p_reason: reason.trim(),
  });
  if (error) throw incomingError(error);
  flushNotificationPush();
}
