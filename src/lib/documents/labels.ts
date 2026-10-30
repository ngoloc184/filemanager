// UI labels for the Documents module: English first, the Vietnamese term
// (Decree 30/2020 wording) in parentheses. Pure, so tests can import it.

import type {
  AssignmentRole,
  AssignmentStatus,
  Confidentiality,
  DocFileKind,
  DocumentStatus,
  Direction,
  OpinionKind,
  RecipientMethod,
  StepKind,
  StepStatus,
  Urgency,
} from "./types.ts";

export const DIRECTION_LABELS: Record<Direction, string> = {
  incoming: "Incoming (Văn bản đến)",
  outgoing: "Outgoing (Văn bản đi)",
  internal: "Internal (Nội bộ)",
};

export const STATUS_LABELS: Record<DocumentStatus, string> = {
  draft: "Draft (Dự thảo)",
  registered: "Registered (Đã vào sổ)",
  submitted: "Submitted to leader (Đã trình)",
  in_progress: "In progress (Đang xử lý)",
  completed: "Completed (Đã xử lý)",
  cancelled: "Cancelled (Đã hủy)",
  archived: "Archived (Đã lưu trữ)",
  in_review: "In review (Đang duyệt)",
  awaiting_signature: "Awaiting signature (Chờ ký)",
  signed: "Signed – ready to issue (Chờ phát hành)",
  issued: "Issued (Đã ban hành)",
  rejected: "Rejected (Bị từ chối)",
  withdrawn: "Withdrawn (Đã rút)",
  recalled: "Recalled (Đã thu hồi)",
};

export const URGENCY_LABELS: Record<Urgency, string> = {
  normal: "Normal",
  khan: "Urgent (Khẩn)",
  thuong_khan: "Very urgent (Thượng khẩn)",
  hoa_toc: "Immediate (Hỏa tốc)",
};

export const CONFIDENTIALITY_LABELS: Record<Confidentiality, string> = {
  normal: "Normal",
  internal: "Internal only (Lưu hành nội bộ)",
  restricted: "Return after reading (Xem xong trả lại)",
  confidential: "Confidential",
};

export const ASSIGNMENT_ROLE_LABELS: Record<AssignmentRole, string> = {
  lead: "Lead (Chủ trì)",
  support: "Support (Phối hợp)",
  info: "For information (Để biết)",
};

export const ASSIGNMENT_STATUS_LABELS: Record<AssignmentStatus, string> = {
  pending: "Not seen yet (Chưa xem)",
  seen: "Seen (Đã xem)",
  in_progress: "In progress (Đang xử lý)",
  done: "Done (Đã xong)",
  returned: "Returned (Trả lại)",
  revoked: "Revoked (Đã thu hồi)",
};

export const STEP_KIND_LABELS: Record<StepKind, string> = {
  review: "Review",
  format_check: "Format check (Kiểm tra thể thức)",
  consult: "Consult (Xin ý kiến)",
  sign: "Sign (Ký duyệt)",
};

export const STEP_STATUS_LABELS: Record<StepStatus, string> = {
  waiting: "Waiting",
  pending: "Pending (Chờ xử lý)",
  approved: "Approved (Đồng ý)",
  returned: "Returned (Trả lại)",
  rejected: "Rejected (Từ chối)",
  skipped: "Skipped",
};

export const OPINION_KIND_LABELS: Record<OpinionKind, string> = {
  instruction: "Instruction (Ý kiến chỉ đạo)",
  proposal: "Proposal (Đề xuất)",
  comment: "Comment (Ý kiến)",
  result: "Result (Kết quả xử lý)",
  consult_reply: "Consultation reply (Góp ý)",
};

export const DOC_FILE_KIND_LABELS: Record<DocFileKind, string> = {
  main: "Main file (Tệp chính)",
  attachment: "Attachment (Phụ lục)",
  signed: "Signed copy (Bản đã ký)",
  draft: "Draft (Dự thảo)",
};

export const RECIPIENT_METHOD_LABELS: Record<RecipientMethod, string> = {
  system: "In the system",
  email: "E-mail",
  post: "Post (Bưu điện)",
  hand: "By hand (Trực tiếp)",
};

const URGENCY_RANK: Record<Urgency, number> = {
  normal: 0,
  khan: 1,
  thuong_khan: 2,
  hoa_toc: 3,
};

/** Sort key: normal 0, khan 1, thuong_khan 2, hoa_toc 3 (unknown → 0). */
export function urgencyRank(urgency: Urgency | string | null | undefined): number {
  return (urgency && URGENCY_RANK[urgency as Urgency]) || 0;
}

export type StatusTone = "neutral" | "info" | "warning" | "success" | "danger";

const STATUS_TONES: Record<DocumentStatus, StatusTone> = {
  draft: "neutral",
  registered: "info",
  submitted: "info",
  in_progress: "info",
  completed: "success",
  cancelled: "neutral",
  archived: "neutral",
  in_review: "info",
  awaiting_signature: "warning",
  signed: "warning",
  issued: "success",
  rejected: "danger",
  withdrawn: "neutral",
  recalled: "danger",
};

/** Colour family of a status badge; unknown statuses are neutral. */
export function statusTone(status: DocumentStatus | string | null | undefined): StatusTone {
  return (status && STATUS_TONES[status as DocumentStatus]) || "neutral";
}

/** Label of a status, or the raw value when it is not known. */
export function statusLabel(status: DocumentStatus | string): string {
  return STATUS_LABELS[status as DocumentStatus] ?? status;
}

const RELATION_LABELS: Record<string, string> = {
  reply_to: "Replies to (Trả lời văn bản)",
  replaces: "Replaces (Thay thế văn bản)",
  corrects: "Corrects (Đính chính văn bản)",
  replied_by: "Replied by (Được trả lời bởi)",
  replaced_by: "Replaced by (Bị thay thế bởi)",
  corrected_by: "Corrected by (Được đính chính bởi)",
};

/** Label of get_document().related[].relation; unknown names are shown as words. */
export function relationLabel(relation: string): string {
  return RELATION_LABELS[relation] ?? relation.replace(/_/g, " ");
}
