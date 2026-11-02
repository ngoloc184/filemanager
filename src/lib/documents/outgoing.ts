// Outgoing and internal documents (văn bản đi / nội bộ): which actions the
// caller may take, the approval chain of the current revision and its
// validation. Mirrors the rules of 202608280041_documents_outgoing.sql; the
// server still enforces every one of them. Pure, so tests can import it.

import type {
  ApprovalStep,
  DocumentBundle,
  RecipientMethod,
  StepKind,
} from "./types.ts";

export type OutgoingAction =
  | "edit"
  | "set_chain"
  | "submit"
  | "approve"
  | "return"
  | "reject"
  | "sign"
  | "issue"
  | "recall"
  | "withdraw"
  | "reply"
  | "replacement"
  | "correction"
  | "upload_signed"
  | "share_draft";

export type FollowUpKind = "reply" | "replacement" | "correction";

/** One step of set_approval_chain's p_steps, in order. */
export type ApprovalChainStepInput = {
  approver_user_id: string;
  kind: StepKind;
  /** shares the previous step's number (only consult steps in the UI) */
  parallel_with_previous?: boolean;
  /** consult steps only: other kinds are always required */
  required?: boolean;
};

/** One recipient of issue_document's p_recipients. */
export type IssueRecipientInput =
  | { kind: "member"; user_id: string }
  | { kind: "department"; department_id: string }
  | { kind: "external"; external_org_id?: string | null; name?: string | null; method?: RecipientMethod };

export type IssueResult = { number: number; notation: string };

export const MAX_CHAIN_STEPS = 10;

/** The steps of one step number (parallel approvers share it). */
export type StepGroup = { step_no: number; steps: ApprovalStep[] };

function isOutgoingDirection(direction: string | null | undefined): boolean {
  return direction === "outgoing" || direction === "internal";
}

/** Steps of the document's current revision grouped by step_no, in order. */
export function currentSteps(bundle: Pick<DocumentBundle, "document" | "approval_steps">): StepGroup[] {
  const revision = bundle.document.revision;
  const groups = new Map<number, ApprovalStep[]>();
  for (const step of bundle.approval_steps ?? []) {
    if (step.revision !== revision) continue;
    const list = groups.get(step.step_no);
    if (list) list.push(step);
    else groups.set(step.step_no, [step]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a - b)
    .map(([step_no, steps]) => ({ step_no, steps }));
}

/** The caller's pending step of the current revision, if any. */
export function myPendingStep(bundle: DocumentBundle): ApprovalStep | null {
  const me = bundle.me?.user_id;
  if (!me) return null;
  for (const group of currentSteps(bundle)) {
    const step = group.steps.find((s) => s.approver_user_id === me && s.status === "pending");
    if (step) return step;
  }
  return null;
}

/** What the caller can do on an outgoing/internal document (empty for incoming). */
export function outgoingActions(bundle: DocumentBundle): OutgoingAction[] {
  const doc = bundle.document;
  if (!doc || !isOutgoingDirection(doc.direction)) return [];
  const me = bundle.me;
  const roles = me?.roles ?? [];
  const isAuthor = !!me?.user_id && doc.created_by === me.user_id;
  const isClerk = roles.includes("clerk");
  const isLeader = roles.includes("leader");
  const isAdmin = roles.includes("org_admin");
  const pending = myPendingStep(bundle);
  const actions: OutgoingAction[] = [];

  switch (doc.status) {
    case "draft":
      if (me?.can_edit) actions.push("edit");
      if (isAuthor) actions.push("set_chain", "submit");
      if (isAuthor || isAdmin) actions.push("share_draft");
      if (isAuthor) actions.push("withdraw");
      break;
    case "in_review":
    case "awaiting_signature":
      if (pending) {
        if (pending.kind === "sign") {
          if (doc.status === "awaiting_signature") actions.push("sign");
        } else {
          actions.push("approve");
        }
        actions.push("return", "reject");
      }
      if (isAuthor) actions.push("withdraw");
      break;
    case "signed":
      if (me?.can_edit) actions.push("edit");
      if (isClerk) actions.push("issue", "upload_signed");
      break;
    case "issued":
      if (isClerk) actions.push("upload_signed");
      if (isClerk || isLeader) actions.push("recall");
      actions.push("reply", "replacement", "correction");
      break;
    default:
      break;
  }
  return actions;
}

/**
 * Problems with a chain before it is saved, in the server's words; empty when
 * it is fine. `people` gives each approver's name and whether they may sign
 * (leader role or a position with can_sign).
 */
export function validateApprovalChain(
  steps: readonly ApprovalChainStepInput[],
  people: ReadonlyMap<string, { name: string; canSign: boolean }>
): string[] {
  const errors: string[] = [];
  const add = (message: string) => {
    if (!errors.includes(message)) errors.push(message);
  };

  if (steps.length > MAX_CHAIN_STEPS) add(`Add at most ${MAX_CHAIN_STEPS} steps`);
  if (steps.some((s) => !s.approver_user_id)) add("Pick a person for every step");

  const signIndexes = steps.flatMap((s, i) => (s.kind === "sign" ? [i] : []));
  if (signIndexes.length !== 1) {
    add("End the chain with exactly one signer");
  } else {
    const at = signIndexes[0];
    if (at !== steps.length - 1 || (at > 0 && steps[at].parallel_with_previous)) {
      add("The signer must be last");
    }
  }
  for (const i of signIndexes) {
    const id = steps[i].approver_user_id;
    if (!id) continue;
    const person = people.get(id);
    if (!person?.canSign) add(`${person?.name || "This person"} cannot sign`);
  }

  // same step number = this step and the parallel ones right after it
  let stepUsers = new Set<string>();
  steps.forEach((s, i) => {
    if (i === 0 || !s.parallel_with_previous) stepUsers = new Set();
    if (!s.approver_user_id) return;
    if (stepUsers.has(s.approver_user_id)) add("A person appears twice in the same step");
    stepUsers.add(s.approver_user_id);
  });
  return errors;
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** One line about where the approval chain stands, e.g. 'Step 2 of 3 · waiting for Lan'. */
export function chainProgressLabel(bundle: Pick<DocumentBundle, "document" | "approval_steps">): string {
  const doc = bundle.document;
  if (!doc || !isOutgoingDirection(doc.direction)) return "";
  const groups = currentSteps(bundle);
  const total = groups.length;

  switch (doc.status) {
    case "draft": {
      const prefix = doc.revision > 1 ? `Revision ${doc.revision} · ` : "";
      if (total === 0) return `${prefix}No approval chain yet`;
      return `${prefix}${plural(total, "step")} · not submitted`;
    }
    case "in_review":
    case "awaiting_signature": {
      const index = groups.findIndex((g) => g.step_no === doc.current_step_no);
      const group = index >= 0 ? groups[index] : groups.find((g) => g.steps.some((s) => s.status === "pending"));
      const position = index >= 0 ? index + 1 : group ? groups.indexOf(group) + 1 : 0;
      const waiting = (group?.steps ?? [])
        .filter((s) => s.status === "pending")
        .map((s) => s.approver_name || "someone");
      const head = position > 0 ? `Step ${position} of ${total}` : plural(total, "step");
      return waiting.length > 0 ? `${head} · waiting for ${joinNames(waiting)}` : head;
    }
    case "signed":
      return "Signed · ready to issue";
    case "issued":
      return doc.notation ? `Issued as ${doc.notation}` : "Issued";
    case "rejected":
      return "Rejected";
    case "withdrawn":
      return "Withdrawn";
    case "recalled":
      return "Recalled";
    default:
      return "";
  }
}
