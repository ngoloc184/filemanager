// Incoming documents (Văn bản đến) workflow rules for the UI. They mirror the
// RPC checks in 202608280040_documents_incoming.sql, so the page only offers
// what the server will accept (the server still decides). Pure: no Supabase
// imports, so tests, server code and client components share them.

import { formatDay } from "./deadlines.ts";
import type { Assignment, AssignmentRole, AssignmentStatus, DocumentBundle } from "./types.ts";

export type IncomingAction =
  | "register"
  | "submit"
  | "assign"
  | "sub_assign"
  | "start"
  | "finish"
  | "return_assignment"
  | "revoke"
  | "complete"
  | "return_to_clerk"
  | "cancel"
  | "reopen"
  | "edit"
  | "reply";

/** Order incomingActions returns them in (primary actions first). */
export const INCOMING_ACTIONS: readonly IncomingAction[] = [
  "register",
  "submit",
  "assign",
  "sub_assign",
  "start",
  "finish",
  "return_assignment",
  "revoke",
  "complete",
  "return_to_clerk",
  "cancel",
  "reopen",
  "edit",
  "reply",
];

/** A duplicate candidate from register_incoming; subject is null when the caller cannot read it. */
export type DuplicateCandidate = {
  id: string;
  notation: string | null;
  arrival_number: number | null;
  subject: string | null;
  arrival_date: string | null;
};

/** register_incoming result: registered, or possible duplicates and nothing changed. */
export type RegisterIncomingResult = {
  ok: boolean;
  arrival_number?: number;
  duplicates?: DuplicateCandidate[];
};

/** One row of assign_document's p_items. */
export type AssignmentItemInput = {
  user_id?: string | null;
  department_id?: string | null;
  role: AssignmentRole;
  due_date?: string | null;
  instruction?: string | null;
};

export const MAX_ASSIGNMENT_ITEMS = 50;
export const MAX_INSTRUCTION_LENGTH = 2000;
export const MAX_RESULT_LENGTH = 5000;

const OPEN_ASSIGNMENT: readonly AssignmentStatus[] = ["pending", "seen", "in_progress"];
const ROLE_ORDER: Record<AssignmentRole, number> = { lead: 0, support: 1, info: 2 };

type Me = Pick<DocumentBundle["me"], "user_id" | "headed_department_ids">;
type AssigneeRef = Pick<Assignment, "assignee_user_id" | "assignee_department_id">;

/** True when `me` is the assignee: the user, or the head of the department (doc_is_my_assignment). */
export function isMyAssignment(a: AssigneeRef, me: Me): boolean {
  if (a.assignee_user_id) return a.assignee_user_id === me.user_id;
  return !!a.assignee_department_id && me.headed_department_ids.includes(a.assignee_department_id);
}

/** Not revoked or returned: it still counts as a sibling and as a lead. */
export function isActiveAssignment(a: Pick<Assignment, "status">): boolean {
  return a.status !== "revoked" && a.status !== "returned";
}

/** The active top-level lead (Chủ trì), the latest one if there were several. */
export function topLevelLead<T extends Assignment>(assignments: readonly T[]): T | null {
  let found: T | null = null;
  for (const a of assignments) {
    if (a.parent_id || a.role !== "lead" || !isActiveAssignment(a)) continue;
    if (!found || time(a.assigned_at) >= time(found.assigned_at)) found = a;
  }
  return found;
}

/** Whether the siblings under `parentId` (null = top level) already have an active lead. */
export function hasActiveLead(assignments: readonly Assignment[], parentId: string | null): boolean {
  return assignments.some(
    (a) => (a.parent_id ?? null) === parentId && a.role === "lead" && isActiveAssignment(a)
  );
}

/** The caller's assignments that still need something from them, lead → support → info. */
export function myOpenAssignments(bundle: Pick<DocumentBundle, "assignments" | "me">): Assignment[] {
  return bundle.assignments
    .filter((a) => OPEN_ASSIGNMENT.includes(a.status) && isMyAssignment(a, bundle.me))
    .sort(compareAssignments);
}

/** What the caller may do on an incoming document; [] for other directions. */
export function incomingActions(bundle: DocumentBundle): IncomingAction[] {
  const { document: doc, me, assignments } = bundle;
  if (doc.direction !== "incoming") return [];

  const roles = me.roles ?? [];
  const isClerk = roles.includes("clerk");
  const leaderish = roles.includes("leader") || roles.includes("org_admin");
  const presentedToMe = !!doc.presented_to && doc.presented_to === me.user_id;
  const status = doc.status;
  const closed = status === "cancelled" || status === "archived";
  const mine = assignments.filter((a) => isMyAssignment(a, me));
  const lead = topLevelLead(assignments);

  const can = new Set<IncomingAction>();
  if (isClerk && status === "draft") can.add("register");
  if (isClerk && status === "registered") can.add("submit");
  if (
    (status === "registered" || status === "submitted" || status === "in_progress") &&
    (presentedToMe || leaderish || (isClerk && status === "registered"))
  ) {
    can.add("assign");
  }
  if (
    (status === "in_progress" || status === "completed") &&
    mine.some((a) => OPEN_ASSIGNMENT.includes(a.status))
  ) {
    can.add("sub_assign");
  }
  if (!closed && mine.some((a) => a.status === "pending" || a.status === "seen")) can.add("start");
  if (!closed && mine.some((a) => OPEN_ASSIGNMENT.includes(a.status))) {
    can.add("finish");
    can.add("return_assignment");
  }
  if (
    assignments.some(
      (a) => a.status === "pending" && (a.assigned_by === me.user_id || roles.includes("org_admin"))
    )
  ) {
    can.add("revoke");
  }
  if (
    status === "in_progress" &&
    (leaderish || presentedToMe || (!!lead && isMyAssignment(lead, me))) &&
    (leaderish || lead?.status === "done")
  ) {
    can.add("complete");
  }
  if (status === "submitted" && presentedToMe) can.add("return_to_clerk");
  if (isClerk && (status === "draft" || status === "registered")) can.add("cancel");
  if (status === "completed" && leaderish) can.add("reopen");
  if (me.can_edit && (status === "draft" || status === "registered")) can.add("edit");
  if (
    (status === "registered" || status === "submitted" || status === "in_progress" || status === "completed") &&
    (leaderish || presentedToMe || mine.some((a) => a.role !== "info" && isActiveAssignment(a)))
  ) {
    can.add("reply");
  }

  return INCOMING_ACTIONS.filter((a) => can.has(a));
}

export type AssignmentNode<T extends AssignmentTreeRow = Assignment> = T & {
  children: AssignmentNode<T>[];
};

type AssignmentTreeRow = Pick<Assignment, "id" | "parent_id" | "role" | "assigned_at">;

/**
 * Assignments nested by parent_id, each level sorted lead → support → info,
 * then by assigned_at. A row whose parent is missing is shown at the top.
 */
export function assignmentTree<T extends AssignmentTreeRow>(assignments: readonly T[]): AssignmentNode<T>[] {
  const nodes = new Map<string, AssignmentNode<T>>();
  for (const a of assignments) nodes.set(a.id, { ...a, children: [] });

  const roots: AssignmentNode<T>[] = [];
  for (const node of nodes.values()) {
    const parent = node.parent_id ? nodes.get(node.parent_id) : undefined;
    if (parent && parent !== node) parent.children.push(node);
    else roots.push(node);
  }

  const sortLevel = (level: AssignmentNode<T>[], seen: Set<string>) => {
    level.sort(compareAssignments);
    for (const node of level) {
      if (seen.has(node.id)) continue;
      seen.add(node.id);
      sortLevel(node.children, seen);
    }
  };
  sortLevel(roots, new Set());
  return roots;
}

export type AssignmentValidationContext = {
  /** An active lead already exists among the siblings (top level, or under the parent). */
  hasActiveLead: boolean;
  /** Sub-assigning under an existing assignment. */
  isSub: boolean;
  /** The parent assignment's deadline (yyyy-mm-dd) when sub-assigning. */
  parentDue?: string | null;
  /** Today in the company's time zone (yyyy-mm-dd). */
  today: string;
  /** Active siblings already assigned (a person or department may appear once). */
  existing?: readonly { user_id?: string | null; department_id?: string | null }[];
};

/** Problems with an assign_document request, in the server's wording; [] when it may be sent. */
export function validateAssignmentItems(
  items: readonly AssignmentItemInput[],
  ctx: AssignmentValidationContext
): string[] {
  const errors: string[] = [];
  const add = (message: string) => {
    if (!errors.includes(message)) errors.push(message);
  };

  if (items.length === 0) add("Add at least one person or department");
  if (items.length > MAX_ASSIGNMENT_ITEMS) add(`At most ${MAX_ASSIGNMENT_ITEMS} assignees at a time`);

  const leads = items.filter((i) => i.role === "lead").length;
  if (!ctx.isSub) {
    if (ctx.hasActiveLead && leads > 0) add("This document already has a lead. Revoke it first.");
    if (!ctx.hasActiveLead && leads !== 1) add("Choose exactly one lead (Chủ trì)");
  } else {
    if (ctx.hasActiveLead && leads > 0) add("This assignment already has a lead. Revoke it first.");
    if (leads > 1) add("Choose at most one lead (Chủ trì)");
  }

  const keys = new Set<string>();
  for (const e of ctx.existing ?? []) {
    const key = assigneeKey(e);
    if (key) keys.add(key);
  }

  for (const item of items) {
    const key = assigneeKey(item);
    if (!key || (item.user_id && item.department_id)) {
      add("Each row needs either a person or a department");
    } else if (keys.has(key)) {
      add("Each person or department can only appear once");
    } else {
      keys.add(key);
    }

    const due = item.due_date || null;
    if (due && due < ctx.today) add("Deadline cannot be in the past");
    if (due && ctx.isSub && ctx.parentDue && due > ctx.parentDue) {
      add(`Deadline must be on or before ${formatDay(ctx.parentDue)}`);
    }
    if ((item.instruction ?? "").trim().length > MAX_INSTRUCTION_LENGTH) {
      add(`The instruction is too long (max ${MAX_INSTRUCTION_LENGTH} characters)`);
    }
  }
  return errors;
}

function assigneeKey(item: { user_id?: string | null; department_id?: string | null }): string | null {
  if (item.user_id) return `user:${item.user_id}`;
  if (item.department_id) return `department:${item.department_id}`;
  return null;
}

function time(value: string): number {
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? 0 : ms;
}

function compareAssignments(a: AssignmentTreeRow, b: AssignmentTreeRow): number {
  return (
    ROLE_ORDER[a.role] - ROLE_ORDER[b.role] ||
    time(a.assigned_at) - time(b.assigned_at) ||
    a.id.localeCompare(b.id)
  );
}
