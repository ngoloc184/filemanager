// Copy for the document action bar: a label (English, Vietnamese term in
// parentheses), a one-line description and a tone for every workflow action
// of incoming.ts and outgoing.ts, plus which action is the main button.
// Pure: no React or Supabase imports, so tests can import it.

import type { IncomingAction } from "./incoming.ts";
import type { OutgoingAction } from "./outgoing.ts";
import type { Direction, SignerAuthority } from "./types.ts";

export type DocumentAction = IncomingAction | OutgoingAction;

export type ActionTone = "primary" | "default" | "danger";

export type ActionCopy = { label: string; description: string; tone: ActionTone };

/**
 * One entry per action key. Keys shared by both flows (edit, submit, reply)
 * carry the outgoing wording here; actionCopy() swaps in the incoming one.
 */
export const ACTION_COPY: Record<DocumentAction, ActionCopy> = {
  // incoming (Văn bản đến)
  register: {
    label: "Register (Vào sổ)",
    description: "Enter the document in an incoming register and give it an arrival number.",
    tone: "primary",
  },
  assign: {
    label: "Assign (Giao xử lý)",
    description: "Choose the lead, supports and info recipients, each with a deadline.",
    tone: "primary",
  },
  sub_assign: {
    label: "Sub-assign (Giao xử lý tiếp)",
    description: "Pass your assignment on to people in your department.",
    tone: "default",
  },
  start: {
    label: "Start work (Bắt đầu xử lý)",
    description: "Tell the person who assigned it that you are working on it.",
    tone: "default",
  },
  finish: {
    label: "Report result (Báo cáo kết quả)",
    description: "Start work, report the result or return your assignment with a reason.",
    tone: "primary",
  },
  return_assignment: {
    label: "Return assignment (Trả lại)",
    description: "Give the assignment back with a reason.",
    tone: "default",
  },
  revoke: {
    label: "Take back assignment (Thu hồi giao việc)",
    description: "Only possible before the person opens it.",
    tone: "default",
  },
  complete: {
    label: "Complete (Hoàn thành xử lý)",
    description: "Close the processing of this document with a result note.",
    tone: "primary",
  },
  return_to_clerk: {
    label: "Return to clerk (Trả lại văn thư)",
    description: "Send the document back to the clerk with a reason.",
    tone: "default",
  },
  cancel: {
    label: "Cancel (Hủy văn bản)",
    description: "Cancel this incoming document. Its arrival number is not reused.",
    tone: "danger",
  },
  reopen: {
    label: "Reopen (Mở lại)",
    description: "Put a completed document back in progress.",
    tone: "default",
  },

  // outgoing / internal (Văn bản đi / nội bộ)
  edit: {
    label: "Edit (Sửa)",
    description: "Change the document's details.",
    tone: "default",
  },
  set_chain: {
    label: "Approval chain (Luồng trình ký)",
    description: "Choose who reviews, checks, is consulted and signs, in order.",
    tone: "default",
  },
  submit: {
    label: "Submit for approval (Trình ký)",
    description: "Send the draft to the first approvers. Its files are locked while it is in review.",
    tone: "primary",
  },
  approve: {
    label: "Approve (Đồng ý)",
    description: "Approve your step and pass the draft to the next one.",
    tone: "primary",
  },
  return: {
    label: "Return for revision (Trả lại)",
    description: "Send the draft back to the author with a comment.",
    tone: "default",
  },
  reject: {
    label: "Reject (Từ chối)",
    description: "This ends the workflow.",
    tone: "danger",
  },
  sign: {
    label: "Sign (Ký duyệt)",
    description: "Record your in-app approval as the signer. It is not a digital signature (chữ ký số).",
    tone: "primary",
  },
  issue: {
    label: "Issue (Phát hành)",
    description: "Give it a number and notation, lock its files and send it to the recipients.",
    tone: "primary",
  },
  recall: {
    label: "Recall (Thu hồi)",
    description: "Take back an issued document. The recipients are told why.",
    tone: "danger",
  },
  withdraw: {
    label: "Withdraw (Rút lại)",
    description: "Stop the workflow of this document. It cannot be resubmitted.",
    tone: "danger",
  },
  reply: {
    label: "Reply (Văn bản trả lời)",
    description: "Start an outgoing draft that answers this document.",
    tone: "default",
  },
  replacement: {
    label: "Replacement (Văn bản thay thế)",
    description: "Start a draft that replaces this issued document.",
    tone: "default",
  },
  correction: {
    label: "Correction (Văn bản đính chính)",
    description: "Start a draft that corrects this issued document.",
    tone: "default",
  },
  upload_signed: {
    label: "Upload signed copy (Bản đã ký)",
    description: "Attach the scanned or digitally signed copy.",
    tone: "default",
  },
  share_draft: {
    label: "Share draft (Chia sẻ dự thảo)",
    description: "Let specific people read or edit this draft.",
    tone: "default",
  },
};

/** Incoming wording for the keys both flows share. */
const INCOMING_COPY: Partial<Record<DocumentAction, ActionCopy>> = {
  submit: {
    label: "Present to leader (Trình lãnh đạo)",
    description: "Send the registered document to a leader or department head for assignment.",
    tone: "primary",
  },
  edit: {
    label: "Edit (Sửa)",
    description: "Correct the registered details of this document.",
    tone: "default",
  },
};

/** The copy of `action` as the document's flow words it. */
export function actionCopy(action: DocumentAction, direction?: Direction | null): ActionCopy {
  if (direction === "incoming") return INCOMING_COPY[action] ?? ACTION_COPY[action];
  return ACTION_COPY[action];
}

/**
 * Most important first. Every action key appears once; the danger ones come
 * last and are never picked as the main button. Complete comes before assign:
 * once the lead has reported, closing the document is the leader's next step.
 */
export const ACTION_PRIORITY: readonly DocumentAction[] = [
  "register",
  "sign",
  "approve",
  "complete",
  "assign",
  "finish",
  "issue",
  "submit",
  "set_chain",
  "sub_assign",
  "start",
  "return_assignment",
  "return",
  "return_to_clerk",
  "upload_signed",
  "reopen",
  "share_draft",
  "reply",
  "replacement",
  "correction",
  "edit",
  "revoke",
  "reject",
  "recall",
  "withdraw",
  "cancel",
];

/**
 * The action for the filled button: the highest priority one that is not
 * dangerous. `leadReported: false` (the top-level lead has not reported yet)
 * puts complete back behind assign: a leader may close early (override), but
 * that is not the next step.
 */
export function primaryAction<T extends DocumentAction>(
  actions: readonly T[],
  context?: { leadReported?: boolean }
): T | null {
  let best: T | null = null;
  let bestRank = Infinity;
  for (const action of actions) {
    if (ACTION_COPY[action].tone === "danger") continue;
    const rank =
      action === "complete" && context?.leadReported === false
        ? ACTION_PRIORITY.indexOf("assign") + 0.5
        : ACTION_PRIORITY.indexOf(action);
    const r = rank < 0 ? ACTION_PRIORITY.length : rank;
    if (r < bestRank) {
      best = action;
      bestRank = r;
    }
  }
  return best;
}

/** Start and return are choices inside the 'Report result' dialog, not separate buttons. */
const OPENS_ASSIGNMENT_UPDATE: readonly DocumentAction[] = ["start", "finish", "return_assignment"];

/**
 * The actions as the bar shows them: one entry per dialog. start / finish /
 * return_assignment all open the assignment update dialog, so they collapse
 * into 'finish'.
 */
export function barActions<T extends DocumentAction>(actions: readonly T[]): T[] {
  const out: T[] = [];
  let updateShown = false;
  for (const action of actions) {
    if (OPENS_ASSIGNMENT_UPDATE.includes(action)) {
      if (updateShown) continue;
      updateShown = true;
      out.push("finish" as T);
      continue;
    }
    if (!out.includes(action)) out.push(action);
  }
  return out;
}

/** Signing authority (thẩm quyền ký) choices: the same values as the sign dialog. */
export const SIGNER_AUTHORITY_OPTIONS: readonly { value: SignerAuthority; label: string }[] = [
  { value: "", label: "Head (ký trực tiếp)" },
  { value: "KT", label: "KT. – signing for the head" },
  { value: "TL", label: "TL. – by order" },
  { value: "TUQ", label: "TUQ. – by authorisation" },
  { value: "TM", label: "TM. – on behalf of the collective" },
  { value: "Q", label: "Q. – acting" },
];
