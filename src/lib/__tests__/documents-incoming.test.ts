import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  INCOMING_ACTIONS,
  assignmentTree,
  hasActiveLead,
  incomingActions,
  isMyAssignment,
  myOpenAssignments,
  topLevelLead,
  validateAssignmentItems,
  type IncomingAction,
} from "../documents/incoming.ts";
import type {
  Assignment,
  AssignmentRole,
  AssignmentStatus,
  DocumentBundle,
  DocumentDetail,
  IncomingStatus,
} from "../documents/types.ts";
import type { OrgRole } from "../org.ts";

const ALICE = "alice"; // leader
const CUONG = "cuong"; // clerk
const HANA = "hana"; // head of HCNS
const SON = "son"; // staff in HCNS
const HCNS = "dept-hcns";

let seq = 0;
function assignment(over: Partial<Assignment> & { role: AssignmentRole }): Assignment {
  seq += 1;
  return {
    id: `a${seq}`,
    document_id: "d1",
    parent_id: null,
    assignee_user_id: null,
    assignee_department_id: null,
    instruction: null,
    due_date: null,
    assigned_by: ALICE,
    assigned_at: `2026-10-0${Math.min(seq, 9)}T08:00:00+00:00`,
    status: "pending",
    seen_at: null,
    done_at: null,
    result: null,
    assignee_name: null,
    assignee_department_name: null,
    assigned_by_name: null,
    ...over,
  };
}

function bundle(opts: {
  status: IncomingStatus;
  user: string;
  roles: OrgRole[];
  headed?: string[];
  presentedTo?: string | null;
  assignments?: Assignment[];
  canEdit?: boolean;
  direction?: "incoming" | "outgoing";
}): DocumentBundle {
  const document = {
    id: "d1",
    direction: opts.direction ?? "incoming",
    status: opts.status,
    presented_to: opts.presentedTo ?? null,
    subject: "Hướng dẫn quyết toán",
  } as DocumentDetail;
  return {
    document,
    files: [],
    assignments: opts.assignments ?? [],
    approval_steps: [],
    opinions: [],
    recipients: [],
    grants: [],
    events: [],
    related: [],
    me: {
      user_id: opts.user,
      roles: opts.roles,
      department_id: null,
      headed_department_ids: opts.headed ?? [],
      can_edit: opts.canEdit ?? false,
    },
  };
}

const sorted = (actions: IncomingAction[]) => [...actions].sort();
const same = (actual: IncomingAction[], expected: IncomingAction[]) =>
  assert.deepEqual(sorted(actual), sorted(expected));

describe("incomingActions: clerk", () => {
  const clerk = (status: IncomingStatus, extra: Partial<Parameters<typeof bundle>[0]> = {}) =>
    incomingActions(bundle({ status, user: CUONG, roles: ["clerk"], ...extra }));

  it("draft: register, cancel, edit", () => {
    same(clerk("draft", { canEdit: true }), ["register", "cancel", "edit"]);
  });
  it("registered: submit, distribute directly, cancel, edit", () => {
    same(clerk("registered", { canEdit: true }), ["submit", "assign", "cancel", "edit"]);
  });
  it("submitted: nothing (the leader has it)", () => {
    same(clerk("submitted"), []);
  });
  it("in progress: can revoke what the clerk assigned while unopened", () => {
    const a = assignment({ role: "lead", assignee_user_id: HANA, assigned_by: CUONG });
    same(clerk("in_progress", { assignments: [a] }), ["revoke"]);
    same(clerk("in_progress", { assignments: [{ ...a, status: "seen" }] }), []);
  });
  it("completed, cancelled, archived: nothing", () => {
    for (const s of ["completed", "cancelled", "archived"] as const) same(clerk(s), []);
  });
  it("other directions: no incoming actions", () => {
    same(clerk("draft", { direction: "outgoing", canEdit: true }), []);
  });
});

describe("incomingActions: leader", () => {
  const leader = (status: IncomingStatus, extra: Partial<Parameters<typeof bundle>[0]> = {}) =>
    incomingActions(bundle({ status, user: ALICE, roles: ["leader"], presentedTo: ALICE, ...extra }));

  it("draft: nothing", () => {
    same(leader("draft"), []);
  });
  it("registered: assign (and reply)", () => {
    same(leader("registered", { presentedTo: null }), ["assign", "reply"]);
  });
  it("submitted to me: assign, return to clerk, reply", () => {
    same(leader("submitted"), ["assign", "return_to_clerk", "reply"]);
  });
  it("submitted to someone else: no return to clerk", () => {
    same(leader("submitted", { presentedTo: HANA }), ["assign", "reply"]);
  });
  it("in progress: assign, complete (override), revoke while unopened", () => {
    const lead = assignment({ role: "lead", assignee_department_id: HCNS });
    same(leader("in_progress", { assignments: [lead] }), ["assign", "revoke", "complete", "reply"]);
    same(leader("in_progress", { assignments: [{ ...lead, status: "in_progress" }] }), [
      "assign",
      "complete",
      "reply",
    ]);
  });
  it("completed: reopen, reply", () => {
    same(leader("completed"), ["reopen", "reply"]);
  });
  it("cancelled: nothing", () => {
    same(leader("cancelled"), []);
  });
});

describe("incomingActions: department head", () => {
  const head = (status: IncomingStatus, assignments: Assignment[]) =>
    incomingActions(bundle({ status, user: HANA, roles: ["dept_head"], headed: [HCNS], assignments }));

  it("pending department lead: sub-assign, start, finish, return, reply", () => {
    const lead = assignment({ role: "lead", assignee_department_id: HCNS });
    same(head("in_progress", [lead]), ["sub_assign", "start", "finish", "return_assignment", "reply"]);
  });
  it("lead done: complete", () => {
    const lead = assignment({ role: "lead", assignee_department_id: HCNS, status: "done" });
    same(head("in_progress", [lead]), ["complete", "reply"]);
  });
  it("lead not done: no complete", () => {
    const lead = assignment({ role: "lead", assignee_department_id: HCNS, status: "in_progress" });
    assert.ok(!head("in_progress", [lead]).includes("complete"));
  });
  it("info for the department: start, finish, no reply", () => {
    const info = assignment({ role: "info", assignee_department_id: HCNS });
    same(head("in_progress", [info]), ["sub_assign", "start", "finish", "return_assignment"]);
  });
  it("revokes a sub-assignment while it is unopened", () => {
    const lead = assignment({ role: "lead", assignee_department_id: HCNS, status: "in_progress" });
    const sub = assignment({ role: "lead", parent_id: lead.id, assignee_user_id: SON, assigned_by: HANA });
    assert.ok(head("in_progress", [lead, sub]).includes("revoke"));
  });
  it("not assigned: nothing", () => {
    same(head("in_progress", []), []);
    same(head("submitted", []), []);
  });
  it("presented to a department head: assign and return to clerk", () => {
    same(
      incomingActions(bundle({ status: "submitted", user: HANA, roles: ["dept_head"], presentedTo: HANA })),
      ["assign", "return_to_clerk", "reply"]
    );
  });
});

describe("incomingActions: staff", () => {
  const staff = (status: IncomingStatus, assignments: Assignment[]) =>
    incomingActions(bundle({ status, user: SON, roles: ["staff"], assignments }));

  it("seen sub-assignment: sub-assign, start, finish, return", () => {
    const a = assignment({ role: "lead", parent_id: "p", assignee_user_id: SON, status: "seen" });
    same(staff("in_progress", [a]), ["sub_assign", "start", "finish", "return_assignment", "reply"]);
  });
  it("in progress: finish or return only", () => {
    const a = assignment({ role: "support", assignee_user_id: SON, status: "in_progress" });
    same(staff("in_progress", [a]), ["sub_assign", "finish", "return_assignment", "reply"]);
  });
  it("support stays open after completion", () => {
    const a = assignment({ role: "support", assignee_user_id: SON, status: "seen" });
    same(staff("completed", [a]), ["sub_assign", "start", "finish", "return_assignment", "reply"]);
  });
  it("done, returned or revoked: nothing", () => {
    for (const s of ["done", "returned", "revoked"] as AssignmentStatus[]) {
      const a = assignment({ role: "support", assignee_user_id: SON, status: s });
      same(staff("in_progress", [a]), s === "done" ? ["reply"] : []);
    }
  });
  it("closed documents: nothing to do", () => {
    const a = assignment({ role: "support", assignee_user_id: SON, status: "seen" });
    same(staff("cancelled", [a]), []);
  });
  it("not assigned in any status: nothing", () => {
    for (const s of ["draft", "registered", "submitted", "in_progress", "completed"] as IncomingStatus[]) {
      same(staff(s, []), []);
    }
  });
  it("returns actions in the canonical order", () => {
    const a = assignment({ role: "lead", assignee_user_id: SON });
    const actions = staff("in_progress", [a]);
    assert.deepEqual(actions, INCOMING_ACTIONS.filter((x) => actions.includes(x)));
  });
});

describe("assignment helpers", () => {
  const me = { user_id: HANA, headed_department_ids: [HCNS] };

  it("isMyAssignment: the user, or the head of the department", () => {
    assert.ok(isMyAssignment({ assignee_user_id: HANA, assignee_department_id: null }, me));
    assert.ok(isMyAssignment({ assignee_user_id: null, assignee_department_id: HCNS }, me));
    assert.ok(!isMyAssignment({ assignee_user_id: SON, assignee_department_id: null }, me));
    assert.ok(!isMyAssignment({ assignee_user_id: null, assignee_department_id: "other" }, me));
    assert.ok(!isMyAssignment({ assignee_user_id: null, assignee_department_id: null }, me));
  });

  it("topLevelLead ignores revoked/returned leads and sub-leads", () => {
    const old = assignment({ role: "lead", assignee_user_id: SON, status: "returned" });
    const sub = assignment({ role: "lead", parent_id: "x", assignee_user_id: SON });
    const lead = assignment({ role: "lead", assignee_department_id: HCNS });
    assert.equal(topLevelLead([old, sub, lead])?.id, lead.id);
    assert.equal(topLevelLead([old, sub]), null);
    assert.ok(hasActiveLead([old, sub, lead], null));
    assert.ok(!hasActiveLead([old], null));
    assert.ok(hasActiveLead([sub], "x"));
  });

  it("myOpenAssignments: mine and open, lead → support → info", () => {
    const info = assignment({ role: "info", assignee_department_id: HCNS });
    const support = assignment({ role: "support", assignee_user_id: HANA });
    const done = assignment({ role: "lead", assignee_user_id: HANA, status: "done" });
    const other = assignment({ role: "lead", assignee_user_id: SON });
    const lead = assignment({ role: "lead", assignee_department_id: HCNS, status: "seen" });
    const result = myOpenAssignments({
      assignments: [info, support, done, other, lead],
      me: { ...me, roles: ["dept_head"], department_id: HCNS, can_edit: false },
    });
    assert.deepEqual(result.map((a) => a.id), [lead.id, support.id, info.id]);
  });
});

describe("assignmentTree", () => {
  it("nests by parent and sorts lead → support → info, then by time", () => {
    const rows = [
      { id: "info", parent_id: null, role: "info" as const, assigned_at: "2026-10-01T08:00:00Z" },
      { id: "s2", parent_id: null, role: "support" as const, assigned_at: "2026-10-01T09:00:00Z" },
      { id: "s1", parent_id: null, role: "support" as const, assigned_at: "2026-10-01T08:30:00Z" },
      { id: "lead", parent_id: null, role: "lead" as const, assigned_at: "2026-10-01T10:00:00Z" },
      { id: "sub-support", parent_id: "lead", role: "support" as const, assigned_at: "2026-10-02T08:00:00Z" },
      { id: "sub-lead", parent_id: "lead", role: "lead" as const, assigned_at: "2026-10-02T09:00:00Z" },
      { id: "deep", parent_id: "sub-lead", role: "info" as const, assigned_at: "2026-10-03T08:00:00Z" },
    ];
    const tree = assignmentTree(rows);
    assert.deepEqual(tree.map((n) => n.id), ["lead", "s1", "s2", "info"]);
    assert.deepEqual(tree[0].children.map((n) => n.id), ["sub-lead", "sub-support"]);
    assert.deepEqual(tree[0].children[0].children.map((n) => n.id), ["deep"]);
    assert.deepEqual(tree[1].children, []);
  });

  it("puts rows whose parent is missing at the top and does not loop on cycles", () => {
    const tree = assignmentTree([
      { id: "orphan", parent_id: "gone", role: "support" as const, assigned_at: "2026-10-01T08:00:00Z" },
      { id: "self", parent_id: "self", role: "lead" as const, assigned_at: "2026-10-01T08:00:00Z" },
    ]);
    assert.deepEqual(tree.map((n) => n.id), ["self", "orphan"]);
  });

  it("keeps the input rows unchanged", () => {
    const rows = [{ id: "a", parent_id: null, role: "lead" as const, assigned_at: "2026-10-01T08:00:00Z" }];
    assignmentTree(rows);
    assert.equal("children" in rows[0], false);
  });
});

describe("validateAssignmentItems", () => {
  const today = "2026-10-30";
  const top = { hasActiveLead: false, isSub: false, today };

  it("accepts one lead with supports and info", () => {
    assert.deepEqual(
      validateAssignmentItems(
        [
          { department_id: HCNS, role: "lead", due_date: "2026-11-04" },
          { user_id: "khoa", role: "support" },
          { department_id: "kt", role: "info" },
        ],
        top
      ),
      []
    );
  });

  it("needs exactly one lead at the top level", () => {
    assert.deepEqual(validateAssignmentItems([{ user_id: "khoa", role: "support" }], top), [
      "Choose exactly one lead (Chủ trì)",
    ]);
    assert.deepEqual(
      validateAssignmentItems(
        [
          { user_id: "khoa", role: "lead" },
          { user_id: SON, role: "lead" },
        ],
        top
      ),
      ["Choose exactly one lead (Chủ trì)"]
    );
  });

  it("refuses a new lead while one is active, and allows supports", () => {
    const ctx = { ...top, hasActiveLead: true };
    assert.deepEqual(validateAssignmentItems([{ user_id: SON, role: "support" }], ctx), []);
    assert.deepEqual(validateAssignmentItems([{ user_id: SON, role: "lead" }], ctx), [
      "This document already has a lead. Revoke it first.",
    ]);
  });

  it("sub-assignments: at most one lead, none required", () => {
    const sub = { hasActiveLead: false, isSub: true, parentDue: "2026-11-04", today };
    assert.deepEqual(validateAssignmentItems([{ user_id: SON, role: "support" }], sub), []);
    assert.deepEqual(
      validateAssignmentItems(
        [
          { user_id: SON, role: "lead" },
          { user_id: "lan", role: "lead" },
        ],
        sub
      ),
      ["Choose at most one lead (Chủ trì)"]
    );
    assert.deepEqual(validateAssignmentItems([{ user_id: SON, role: "lead" }], { ...sub, hasActiveLead: true }), [
      "This assignment already has a lead. Revoke it first.",
    ]);
  });

  it("each person or department only once, also against active siblings", () => {
    assert.deepEqual(
      validateAssignmentItems(
        [
          { user_id: "khoa", role: "lead" },
          { user_id: "khoa", role: "support" },
          { user_id: "khoa", role: "info" },
        ],
        top
      ),
      ["Each person or department can only appear once"]
    );
    assert.deepEqual(
      validateAssignmentItems([{ department_id: "kt", role: "info" }], {
        ...top,
        hasActiveLead: true,
        existing: [{ department_id: "kt" }],
      }),
      ["Each person or department can only appear once"]
    );
    // the same id as a person and as a department are different assignees
    assert.deepEqual(
      validateAssignmentItems(
        [
          { user_id: "x", role: "lead" },
          { department_id: "x", role: "info" },
        ],
        top
      ),
      []
    );
  });

  it("each row needs a person or a department, not both", () => {
    assert.deepEqual(validateAssignmentItems([{ role: "lead" }], top), [
      "Each row needs either a person or a department",
    ]);
    assert.deepEqual(validateAssignmentItems([{ user_id: SON, department_id: HCNS, role: "lead" }], top), [
      "Each row needs either a person or a department",
    ]);
  });

  it("deadlines: not in the past, not after the parent", () => {
    assert.deepEqual(validateAssignmentItems([{ user_id: SON, role: "lead", due_date: "2026-10-29" }], top), [
      "Deadline cannot be in the past",
    ]);
    assert.deepEqual(validateAssignmentItems([{ user_id: SON, role: "lead", due_date: today }], top), []);
    const sub = { hasActiveLead: false, isSub: true, parentDue: "2026-11-04", today };
    assert.deepEqual(validateAssignmentItems([{ user_id: SON, role: "lead", due_date: "2026-11-05" }], sub), [
      "Deadline must be on or before 04/11/2026",
    ]);
    assert.deepEqual(validateAssignmentItems([{ user_id: SON, role: "lead", due_date: "2026-11-04" }], sub), []);
    // without a parent deadline any future date is fine
    assert.deepEqual(
      validateAssignmentItems([{ user_id: SON, role: "lead", due_date: "2027-01-04" }], { ...sub, parentDue: null }),
      []
    );
  });

  it("counts and instruction length", () => {
    assert.deepEqual(validateAssignmentItems([], top), [
      "Add at least one person or department",
      "Choose exactly one lead (Chủ trì)",
    ]);
    const many = Array.from({ length: 51 }, (_, i) => ({ user_id: `u${i}`, role: i === 0 ? "lead" : "info" }) as const);
    assert.deepEqual(validateAssignmentItems(many, top), ["At most 50 assignees at a time"]);
    assert.deepEqual(
      validateAssignmentItems([{ user_id: SON, role: "lead", instruction: "x".repeat(2001) }], top),
      ["The instruction is too long (max 2000 characters)"]
    );
  });
});
