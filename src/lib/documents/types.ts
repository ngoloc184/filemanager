// Documents (Văn bản) module types. They mirror the tables, checks and the
// get_document JSON of 202608280036_documents_core.sql. Pure: no Supabase
// imports, so tests, server code and client components share them.

import type { OrgRole } from "../org.ts";

export const DIRECTIONS = ["incoming", "outgoing", "internal"] as const;
export type Direction = (typeof DIRECTIONS)[number];

/** Văn bản đến: register, submit to a leader, assign, process, complete. */
export const INCOMING_STATUSES = [
  "draft",
  "registered",
  "submitted",
  "in_progress",
  "completed",
  "cancelled",
  "archived",
] as const;
export type IncomingStatus = (typeof INCOMING_STATUSES)[number];

/** Văn bản đi / nội bộ: draft, approval chain, sign, issue. */
export const OUTGOING_STATUSES = [
  "draft",
  "in_review",
  "awaiting_signature",
  "signed",
  "issued",
  "rejected",
  "withdrawn",
  "recalled",
  "archived",
] as const;
export type OutgoingStatus = (typeof OUTGOING_STATUSES)[number];

export type DocumentStatus = IncomingStatus | OutgoingStatus;

/** Statuses after which nothing is due any more (no deadline badge). */
export const FINAL_STATUSES = [
  "completed",
  "cancelled",
  "archived",
  "issued",
  "rejected",
  "withdrawn",
  "recalled",
] as const satisfies readonly DocumentStatus[];

export function isFinalStatus(status: string | null | undefined): boolean {
  return !!status && (FINAL_STATUSES as readonly string[]).includes(status);
}

/** The statuses a document of `direction` may have (the SQL status CHECK). */
export function statusesFor(direction: Direction): readonly DocumentStatus[] {
  return direction === "incoming" ? INCOMING_STATUSES : OUTGOING_STATUSES;
}

export const URGENCIES = ["normal", "khan", "thuong_khan", "hoa_toc"] as const;
export type Urgency = (typeof URGENCIES)[number];

export const CONFIDENTIALITIES = ["normal", "internal", "restricted", "confidential"] as const;
export type Confidentiality = (typeof CONFIDENTIALITIES)[number];

export const ASSIGNMENT_ROLES = ["lead", "support", "info"] as const;
export type AssignmentRole = (typeof ASSIGNMENT_ROLES)[number];

export const ASSIGNMENT_STATUSES = ["pending", "seen", "in_progress", "done", "returned", "revoked"] as const;
export type AssignmentStatus = (typeof ASSIGNMENT_STATUSES)[number];

export const STEP_KINDS = ["review", "format_check", "consult", "sign"] as const;
export type StepKind = (typeof STEP_KINDS)[number];

export const STEP_STATUSES = ["waiting", "pending", "approved", "returned", "rejected", "skipped"] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

export const OPINION_KINDS = ["instruction", "proposal", "comment", "result", "consult_reply"] as const;
export type OpinionKind = (typeof OPINION_KINDS)[number];

export const DOC_FILE_KINDS = ["main", "attachment", "signed", "draft"] as const;
export type DocFileKind = (typeof DOC_FILE_KINDS)[number];

export const RECIPIENT_KINDS = ["member", "department", "external"] as const;
export type RecipientKind = (typeof RECIPIENT_KINDS)[number];

export const RECIPIENT_METHODS = ["system", "email", "post", "hand"] as const;
export type RecipientMethod = (typeof RECIPIENT_METHODS)[number];

/** KT (ký thay), TL (thừa lệnh), TUQ (thừa ủy quyền), TM (thay mặt), Q (quyền); '' = signs in own name. */
export const SIGNER_AUTHORITIES = ["", "KT", "TL", "TUQ", "TM", "Q"] as const;
export type SignerAuthority = (typeof SIGNER_AUTHORITIES)[number];

export type DocAccess = "read" | "edit";
export type DocAccessAction = "view" | "download" | "print";
export type RegisterScope = "register" | "register_type";

/**
 * Canonical document_events.action values (the CHECK in the migration).
 * Every task writes and reads only these names.
 */
export const DOC_EVENT_ACTIONS = [
  "created",
  "profile_updated",
  "file_attached",
  "file_detached",
  "opinion_added",
  "access_granted",
  "access_revoked",
  "registered",
  "submitted",
  "returned_to_clerk",
  "assigned",
  "seen",
  "assignment_updated",
  "assignment_revoked",
  "completed",
  "reopened",
  "cancelled",
  "chain_set",
  "submitted_for_approval",
  "approved",
  "returned",
  "rejected",
  "signed",
  "issued",
  "manual_number_override",
  "recalled",
  "withdrawn",
  "follow_up_created",
  "reassigned",
  "filed",
  "unfiled",
  "archived",
] as const;
export type DocEventAction = (typeof DOC_EVENT_ACTIONS)[number];

export function isDocEventAction(value: unknown): value is DocEventAction {
  return typeof value === "string" && (DOC_EVENT_ACTIONS as readonly string[]).includes(value);
}

/** One row of public.documents (dates are yyyy-mm-dd, timestamps ISO strings). */
export type DocumentRow = {
  id: string;
  org_id: string;
  direction: Direction;
  status: DocumentStatus;
  register_id: string | null;
  number: number | null;
  notation: string | null;
  arrival_number: number | null;
  arrival_date: string | null;
  doc_type_id: string | null;
  field_id: string | null;
  subject: string;
  issuing_org_name: string | null;
  external_org_id: string | null;
  issued_date: string | null;
  signer_name: string | null;
  signer_position: string | null;
  signer_user_id: string | null;
  signer_authority: SignerAuthority;
  page_count: number | null;
  copies: number | null;
  urgency: Urgency;
  confidentiality: Confidentiality;
  due_date: string | null;
  drafting_department_id: string | null;
  created_by: string | null;
  presented_to: string | null;
  reply_to_id: string | null;
  replaces_id: string | null;
  corrects_id: string | null;
  keywords: string[];
  description: string | null;
  revision: number;
  current_step_no: number | null;
  registered_at: string | null;
  submitted_at: string | null;
  signed_at: string | null;
  signed_checksum: string | null;
  issued_at: string | null;
  completed_at: string | null;
  result_note: string | null;
  recalled_at: string | null;
  recall_reason: string | null;
  cancelled_at: string | null;
  archived_at: string | null;
  search_norm?: string | null;
  created_at: string;
  updated_at: string;
};

/** get_document().document: the row plus display names of its lookups. */
export type DocumentDetail = DocumentRow & {
  type_name: string | null;
  type_abbreviation: string | null;
  is_cong_van: boolean | null;
  field_name: string | null;
  register_name: string | null;
  external_org_name: string | null;
  drafting_department_name: string | null;
  drafting_department_code: string | null;
  created_by_name: string | null;
  presented_to_name: string | null;
  signer_display: string | null;
};

/** A file linked to a document (document_files joined with files). */
export type DocumentFileLink = {
  id: string;
  file_id: string;
  kind: DocFileKind;
  frozen: boolean;
  name: string;
  size: number;
  mime_type: string | null;
  current_version_id: string | null;
  owner_id: string;
  added_at: string;
};

export type Assignment = {
  id: string;
  document_id: string;
  parent_id: string | null;
  assignee_user_id: string | null;
  assignee_department_id: string | null;
  role: AssignmentRole;
  instruction: string | null;
  due_date: string | null;
  assigned_by: string | null;
  assigned_at: string;
  status: AssignmentStatus;
  seen_at: string | null;
  done_at: string | null;
  result: string | null;
  assignee_name: string | null;
  assignee_department_name: string | null;
  assigned_by_name: string | null;
};

export type ApprovalStep = {
  id: string;
  document_id: string;
  revision: number;
  step_no: number;
  kind: StepKind;
  approver_user_id: string | null;
  required: boolean;
  status: StepStatus;
  comment: string | null;
  acted_at: string | null;
  acted_by: string | null;
  approver_name: string | null;
};

export type Opinion = {
  id: string;
  document_id: string;
  author_id: string | null;
  kind: OpinionKind;
  body: string;
  created_at: string;
  author_name: string | null;
};

export type DocEvent = {
  id: number;
  org_id: string;
  document_id: string | null;
  actor_id: string | null;
  action: DocEventAction;
  from_status: string | null;
  to_status: string | null;
  data: Record<string, unknown>;
  created_at: string;
  actor_name: string | null;
};

export type Recipient = {
  id: string;
  document_id: string;
  kind: RecipientKind;
  user_id: string | null;
  department_id: string | null;
  external_org_id: string | null;
  name_snapshot: string;
  method: RecipientMethod;
  sent_at: string | null;
  acknowledged_at: string | null;
  note: string | null;
};

export type DocGrant = { user_id: string; name: string | null; access: DocAccess };

/**
 * A linked document. `relation` names the link from this document's side
 * (reply_to / replaces / corrects, or a reverse link). When the caller cannot
 * read it, subject and notation are null and readable is false.
 */
export type RelatedDocument = {
  id: string;
  subject: string | null;
  notation: string | null;
  direction: Direction;
  relation: string;
  readable: boolean;
};

/** The caller as get_document sees them. */
export type DocMe = {
  user_id: string;
  roles: OrgRole[];
  department_id: string | null;
  headed_department_ids: string[];
  can_edit: boolean;
};

/** get_document(p_id) JSON. */
export type DocumentBundle = {
  document: DocumentDetail;
  files: DocumentFileLink[];
  assignments: Assignment[];
  approval_steps: ApprovalStep[];
  opinions: Opinion[];
  recipients: Recipient[];
  grants: DocGrant[];
  events: DocEvent[];
  related: RelatedDocument[];
  me: DocMe;
};

/** Keys update_document_profile accepts (others are ignored by the server). */
export type DocumentProfileInput = {
  subject?: string;
  doc_type_id?: string | null;
  field_id?: string | null;
  urgency?: Urgency;
  confidentiality?: Confidentiality;
  due_date?: string | null;
  issuing_org_name?: string | null;
  external_org_id?: string | null;
  /** incoming only: the sender's number and notation */
  notation?: string | null;
  /** incoming only */
  issued_date?: string | null;
  /** incoming only */
  arrival_date?: string | null;
  signer_name?: string | null;
  signer_position?: string | null;
  page_count?: number | null;
  copies?: number | null;
  /** at most 10, each at most 50 characters */
  keywords?: string[];
  description?: string | null;
  drafting_department_id?: string | null;
  reply_to_id?: string | null;
};

// ---------------------------------------------------------------- lookups

export type DocType = {
  id: string;
  org_id: string;
  name: string;
  abbreviation: string;
  is_cong_van: boolean;
  default_retention_code: string | null;
  active: boolean;
  sort_order: number;
};

export type DocField = { id: string; org_id: string; name: string; active: boolean };

export type ExternalOrg = {
  id: string;
  org_id: string;
  name: string;
  code: string | null;
  email: string | null;
  address: string | null;
  active: boolean;
};

export type DocRegister = {
  id: string;
  org_id: string;
  direction: Direction;
  name: string;
  year: number;
  start_number: number;
  scope: RegisterScope;
  notation_template: string;
  cong_van_template: string;
  is_confidential: boolean;
  allowed_type_ids: string[];
  closed_at: string | null;
  created_by: string | null;
  created_at: string;
};
