// Timeline text and icons for document_events (Lịch sử xử lý). The data keys
// come from the doc_log calls in 202608280036_documents_core.sql,
// 202608280038_offboarding.sql, 202608280040_documents_incoming.sql,
// 202608280041_documents_outgoing.sql and 202608280043_dossiers_retention.sql.
// Pure: no React, no Supabase, so node:test can run it.

import { ASSIGNMENT_ROLE_LABELS, DOC_FILE_KIND_LABELS, STEP_KIND_LABELS } from "./labels.ts";
import type { AssignmentRole, DocEventAction, DocFileKind, OpinionKind, StepKind } from "./types.ts";

/** The parts of a DocEvent the label needs; unknown actions are allowed. */
export type DocEventLike = {
  action: DocEventAction | string;
  data?: Record<string, unknown> | null;
};

/** Short opinion kind chips for the page and the timeline. */
export const OPINION_CHIP_LABELS: Record<OpinionKind, string> = {
  instruction: "Instruction (Chỉ đạo)",
  proposal: "Proposal (Đề xuất)",
  comment: "Comment (Góp ý)",
  result: "Result (Kết quả)",
  consult_reply: "Consult reply (Ý kiến)",
};

/** lucide-react component name per canonical action. */
const EVENT_ICONS: Record<DocEventAction, string> = {
  created: "FilePlus",
  profile_updated: "PencilLine",
  file_attached: "Paperclip",
  file_detached: "FileMinus",
  opinion_added: "MessageSquare",
  access_granted: "UserPlus",
  access_revoked: "UserMinus",
  registered: "BookMarked",
  submitted: "Send",
  returned_to_clerk: "Undo2",
  assigned: "UserCheck",
  seen: "Eye",
  assignment_updated: "ListChecks",
  assignment_revoked: "UserX",
  completed: "CircleCheck",
  reopened: "RotateCcw",
  cancelled: "Ban",
  chain_set: "ListOrdered",
  submitted_for_approval: "SendHorizontal",
  approved: "ThumbsUp",
  returned: "Undo2",
  rejected: "CircleX",
  signed: "PenLine",
  issued: "Stamp",
  manual_number_override: "Hash",
  recalled: "Undo",
  withdrawn: "ArchiveX",
  follow_up_created: "GitBranch",
  reassigned: "ArrowRightLeft",
  filed: "FolderInput",
  unfiled: "FolderOutput",
  archived: "Archive",
};

/** Icon for actions outside DOC_EVENT_ACTIONS. */
export const DEFAULT_EVENT_ICON = "History";

/** Names of update_document_profile keys, for 'profile_updated'. */
const PROFILE_FIELD_LABELS: Record<string, string> = {
  subject: "Subject",
  doc_type_id: "Type",
  field_id: "Field",
  urgency: "Urgency",
  confidentiality: "Confidentiality",
  due_date: "Due date",
  issuing_org_name: "Issuing organisation",
  external_org_id: "Issuing organisation",
  notation: "Number/notation",
  issued_date: "Date of document",
  arrival_date: "Arrival date",
  signer_name: "Signer",
  signer_position: "Signer position",
  page_count: "Pages",
  copies: "Copies",
  keywords: "Keywords",
  description: "Description",
  drafting_department_id: "Drafting department",
  reply_to_id: "Replies to",
};

const FOLLOW_UP_NOUNS: Record<string, string> = {
  reply: "reply",
  replacement: "replacement",
  correction: "correction",
};

const MAX_DETAIL_LENGTH = 200;

function text(data: Record<string, unknown> | null | undefined, key: string): string | null {
  const value = data?.[key];
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    return trimmed.length > MAX_DETAIL_LENGTH ? `${trimmed.slice(0, MAX_DETAIL_LENGTH - 1)}…` : trimmed;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

/** ": <reason>" when data[key] has text, else "". */
function suffix(data: Record<string, unknown> | null | undefined, key = "reason"): string {
  const value = text(data, key);
  return value ? `: ${value}` : "";
}

/** "lead_role" → "Lead role"; the fallback for actions this file does not know. */
export function sentenceCase(action: string): string {
  const words = action.replace(/[_.-]+/g, " ").trim().replace(/\s+/g, " ").toLowerCase();
  return words ? words[0].toUpperCase() + words.slice(1) : "Event";
}

/** Display names of the fields a 'profile_updated' event changed, in order, without repeats. */
export function changedFieldNames(data: Record<string, unknown> | null | undefined): string[] {
  const changed = data?.changed;
  if (!changed || typeof changed !== "object" || Array.isArray(changed)) return [];
  const names: string[] = [];
  for (const key of Object.keys(changed)) {
    const name = PROFILE_FIELD_LABELS[key] ?? sentenceCase(key.replace(/_id$/, ""));
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

/** "Lan (Lead), Sales (Support)" from the 'assigned' items. */
function assignedNames(data: Record<string, unknown> | null | undefined): string {
  const items = data?.items;
  if (!Array.isArray(items)) return "";
  const parts: string[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const name = text(row, "name");
    if (!name) continue;
    const role = ASSIGNMENT_ROLE_LABELS[row.role as AssignmentRole];
    parts.push(role ? `${name} – ${role}` : name);
  }
  return parts.join(", ");
}

/** One line for the timeline, e.g. 'Registered as arrival no. 12'. */
export function eventLabel(e: DocEventLike): string {
  const data = e.data ?? {};
  switch (e.action) {
    case "created": {
      const followUp = FOLLOW_UP_NOUNS[text(data, "follow_up") ?? ""];
      return followUp ? `Created as a ${followUp}` : "Created";
    }
    case "profile_updated": {
      const names = changedFieldNames(data);
      return names.length > 0 ? `Updated ${names.join(", ")}` : "Updated details";
    }
    case "file_attached":
    case "file_detached": {
      const kind = DOC_FILE_KIND_LABELS[data.kind as DocFileKind];
      const name = text(data, "name");
      const what = [kind ?? "File", name ? `“${name}”` : ""].filter(Boolean).join(" ");
      return e.action === "file_attached" ? `Attached ${what}` : `Removed ${what}`;
    }
    case "opinion_added": {
      const kind = OPINION_CHIP_LABELS[data.kind as OpinionKind];
      return kind ? `Added an opinion · ${kind}` : "Added an opinion";
    }
    case "access_granted":
      return data.access === "edit" ? "Shared with edit access" : "Shared with view access";
    case "access_revoked":
      return "Removed someone's access";
    case "registered": {
      const number = text(data, "arrival_number");
      const head = number ? `Registered as arrival no. ${number}` : "Registered";
      const reason = text(data, "duplicate_reason");
      return reason ? `${head} (duplicate allowed: ${reason})` : head;
    }
    case "submitted": {
      const name = text(data, "to_name");
      return name ? `Submitted to ${name}` : "Submitted to a leader";
    }
    case "returned_to_clerk":
      return `Returned to the clerk${suffix(data)}`;
    case "assigned": {
      const head = data.parent_id ? "Sub-assigned" : "Assigned";
      const names = assignedNames(data);
      return names ? `${head}: ${names}` : head;
    }
    case "seen":
      return "Opened";
    case "assignment_updated":
      switch (data.status) {
        case "in_progress":
          return "Started processing";
        case "done":
          return "Reported the result";
        case "returned":
          return `Returned the assignment${suffix(data)}`;
        default:
          return "Updated an assignment";
      }
    case "assignment_revoked":
      return "Withdrew an assignment";
    case "completed":
      return `${data.override === true ? "Completed (by a leader)" : "Completed"}${suffix(data, "result_note")}`;
    case "reopened":
      return `Reopened${suffix(data)}`;
    case "cancelled":
      return `Cancelled${suffix(data)}`;
    case "chain_set": {
      const steps = text(data, "step_count") ?? text(data, "steps");
      return steps ? `Set the approval chain (${steps} ${steps === "1" ? "step" : "steps"})` : "Set the approval chain";
    }
    case "submitted_for_approval":
      return "Sent for approval";
    case "approved": {
      const kind = STEP_KIND_LABELS[data.kind as StepKind];
      return kind && data.kind !== "review" ? `Approved · ${kind}` : "Approved";
    }
    case "returned":
      return "Returned for revision";
    case "rejected":
      return "Rejected";
    case "signed": {
      const authority = text(data, "authority");
      return authority ? `Signed (${authority}.)` : "Signed";
    }
    case "issued": {
      const notation = text(data, "notation");
      return notation ? `Issued as ${notation}` : "Issued";
    }
    case "manual_number_override": {
      const number = text(data, "number");
      return number ? `Number set by hand: ${number}` : "Number set by hand";
    }
    case "recalled":
      return `Recalled${suffix(data)}`;
    case "withdrawn":
      return "Withdrawn";
    case "follow_up_created": {
      const noun = FOLLOW_UP_NOUNS[text(data, "kind") ?? ""] ?? "follow-up document";
      if (data.source_id) return `Drafted as a ${noun} to another document`;
      return `A ${noun} was drafted`;
    }
    case "reassigned": {
      const what = data.approval_step_id ? "Approval step handed over" : "Assignment handed over";
      return data.reason === "offboarding" ? `${what} (member left)` : what;
    }
    case "filed": {
      const code = text(data, "code");
      return code ? `Filed in dossier ${code}` : "Filed in a dossier";
    }
    case "unfiled": {
      const code = text(data, "code");
      return code ? `Removed from dossier ${code}` : "Removed from a dossier";
    }
    case "archived": {
      const code = text(data, "code");
      return code ? `Archived with dossier ${code}` : "Archived";
    }
    default:
      return sentenceCase(String(e.action ?? ""));
  }
}

/** lucide-react icon name for an action; unknown actions get DEFAULT_EVENT_ICON. */
export function eventIcon(action: DocEventAction | string): string {
  return Object.hasOwn(EVENT_ICONS, action) ? EVENT_ICONS[action as DocEventAction] : DEFAULT_EVENT_ICON;
}

/** Every icon name eventIcon can return (the timeline maps each to a component). */
export const EVENT_ICON_NAMES: readonly string[] = [
  ...new Set([...Object.values(EVENT_ICONS), DEFAULT_EVENT_ICON]),
];
