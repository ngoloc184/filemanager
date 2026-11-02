import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  chainProgressLabel,
  currentSteps,
  myPendingStep,
  outgoingActions,
  validateApprovalChain,
  type ApprovalChainStepInput,
} from "../documents/outgoing.ts";
import type {
  ApprovalStep,
  DocumentBundle,
  DocumentDetail,
  DocumentStatus,
  StepKind,
  StepStatus,
} from "../documents/types.ts";
import type { OrgRole } from "../org.ts";

const LAN = "u-lan";
const HANA = "u-hana";
const KHOA = "u-khoa";
const ALICE = "u-alice";
const CUONG = "u-cuong";

const NAMES: Record<string, string> = {
  [LAN]: "Lan",
  [HANA]: "Hana",
  [KHOA]: "Khoa",
  [ALICE]: "Alice",
  [CUONG]: "Cuong",
};

let stepSeq = 0;
function step(
  revision: number,
  step_no: number,
  kind: StepKind,
  approver: string,
  status: StepStatus,
  required = kind !== "consult"
): ApprovalStep {
  stepSeq += 1;
  return {
    id: `s${stepSeq}`,
    document_id: "d1",
    revision,
    step_no,
    kind,
    approver_user_id: approver,
    required,
    status,
    comment: null,
    acted_at: null,
    acted_by: null,
    approver_name: NAMES[approver] ?? null,
  };
}

function bundle(options: {
  status: DocumentStatus;
  me: string;
  roles?: OrgRole[];
  canEdit?: boolean;
  direction?: "incoming" | "outgoing" | "internal";
  revision?: number;
  currentStep?: number | null;
  steps?: ApprovalStep[];
  notation?: string | null;
}): DocumentBundle {
  const document = {
    id: "d1",
    direction: options.direction ?? "outgoing",
    status: options.status,
    created_by: LAN,
    revision: options.revision ?? 1,
    current_step_no: options.currentStep ?? null,
    notation: options.notation ?? null,
    subject: "Quyết định khen thưởng",
  } as DocumentDetail;
  return {
    document,
    files: [],
    assignments: [],
    approval_steps: options.steps ?? [],
    opinions: [],
    recipients: [],
    grants: [],
    events: [],
    related: [],
    me: {
      user_id: options.me,
      roles: options.roles ?? ["staff"],
      department_id: null,
      headed_department_ids: [],
      can_edit: options.canEdit ?? false,
    },
  };
}

// The fixture chain: Hana review + Khoa optional consult (step 1), Alice sign (step 2).
const chainRev1 = (s1: StepStatus, s2: StepStatus) => [
  step(1, 1, "review", HANA, s1),
  step(1, 1, "consult", KHOA, s1),
  step(1, 2, "sign", ALICE, s2),
];

describe("outgoingActions", () => {
  it("draft: the author edits, sets the chain, submits, shares and withdraws", () => {
    assert.deepEqual(outgoingActions(bundle({ status: "draft", me: LAN, canEdit: true })), [
      "edit",
      "set_chain",
      "submit",
      "share_draft",
      "withdraw",
    ]);
  });

  it("draft: an admin may share it, someone with an edit grant may edit it, others nothing", () => {
    assert.deepEqual(outgoingActions(bundle({ status: "draft", me: ALICE, roles: ["org_admin", "leader"] })), [
      "share_draft",
    ]);
    assert.deepEqual(outgoingActions(bundle({ status: "draft", me: KHOA, canEdit: true })), ["edit"]);
    assert.deepEqual(outgoingActions(bundle({ status: "draft", me: KHOA })), []);
  });

  it("in review: a pending reviewer approves, returns or rejects; the author may withdraw", () => {
    const steps = chainRev1("pending", "waiting");
    assert.deepEqual(outgoingActions(bundle({ status: "in_review", me: HANA, currentStep: 1, steps })), [
      "approve",
      "return",
      "reject",
    ]);
    assert.deepEqual(outgoingActions(bundle({ status: "in_review", me: KHOA, currentStep: 1, steps })), [
      "approve",
      "return",
      "reject",
    ]);
    assert.deepEqual(outgoingActions(bundle({ status: "in_review", me: LAN, currentStep: 1, steps })), ["withdraw"]);
  });

  it("in review: the signer has nothing to do before their turn", () => {
    const steps = chainRev1("pending", "waiting");
    assert.deepEqual(
      outgoingActions(bundle({ status: "in_review", me: ALICE, roles: ["leader"], currentStep: 1, steps })),
      []
    );
  });

  it("awaiting signature: the signer signs (never approve), returns or rejects", () => {
    const steps = [
      step(1, 1, "review", HANA, "approved"),
      step(1, 1, "consult", KHOA, "skipped"),
      step(1, 2, "sign", ALICE, "pending"),
    ];
    const actions = outgoingActions(
      bundle({ status: "awaiting_signature", me: ALICE, roles: ["leader"], currentStep: 2, steps })
    );
    assert.deepEqual(actions, ["sign", "return", "reject"]);
    assert.ok(!actions.includes("approve"));
    assert.deepEqual(outgoingActions(bundle({ status: "awaiting_signature", me: HANA, currentStep: 2, steps })), []);
  });

  it("only steps of the current revision count", () => {
    // revision 1 was returned by Hana; revision 2 is in review with Hana pending
    const steps = [
      step(1, 1, "review", HANA, "returned"),
      step(1, 2, "sign", ALICE, "pending"),
      step(2, 1, "review", HANA, "pending"),
      step(2, 2, "sign", ALICE, "waiting"),
    ];
    assert.deepEqual(
      outgoingActions(bundle({ status: "in_review", me: ALICE, roles: ["leader"], revision: 2, currentStep: 1, steps })),
      []
    );
    assert.equal(
      myPendingStep(bundle({ status: "in_review", me: HANA, revision: 2, currentStep: 1, steps }))?.revision,
      2
    );
  });

  it("signed: the clerk issues and uploads the signed copy; the clerk may also complete metadata", () => {
    assert.deepEqual(outgoingActions(bundle({ status: "signed", me: CUONG, roles: ["clerk"], canEdit: true })), [
      "edit",
      "issue",
      "upload_signed",
    ]);
    assert.deepEqual(outgoingActions(bundle({ status: "signed", me: LAN })), []);
  });

  it("issued: clerks and leaders recall; readers start follow-ups", () => {
    assert.deepEqual(outgoingActions(bundle({ status: "issued", me: CUONG, roles: ["clerk"] })), [
      "upload_signed",
      "recall",
      "reply",
      "replacement",
      "correction",
    ]);
    assert.deepEqual(outgoingActions(bundle({ status: "issued", me: ALICE, roles: ["leader"] })), [
      "recall",
      "reply",
      "replacement",
      "correction",
    ]);
    assert.deepEqual(outgoingActions(bundle({ status: "issued", me: KHOA })), ["reply", "replacement", "correction"]);
  });

  it("terminal statuses offer nothing", () => {
    for (const status of ["rejected", "withdrawn", "recalled", "archived"] as const) {
      assert.deepEqual(outgoingActions(bundle({ status, me: LAN, roles: ["clerk", "leader"] })), [], status);
    }
  });

  it("incoming documents are not handled here", () => {
    assert.deepEqual(
      outgoingActions(bundle({ status: "draft", me: LAN, direction: "incoming", canEdit: true })),
      []
    );
  });

  it("internal documents follow the same rules", () => {
    assert.deepEqual(outgoingActions(bundle({ status: "signed", me: CUONG, roles: ["clerk"], direction: "internal" })), [
      "issue",
      "upload_signed",
    ]);
  });
});

describe("currentSteps", () => {
  it("groups the current revision by step number, in order", () => {
    const steps = [
      step(2, 2, "sign", ALICE, "waiting"),
      step(1, 1, "review", HANA, "returned"),
      step(2, 1, "review", HANA, "pending"),
      step(2, 1, "consult", KHOA, "pending"),
    ];
    const groups = currentSteps(bundle({ status: "in_review", me: LAN, revision: 2, currentStep: 1, steps }));
    assert.deepEqual(
      groups.map((g) => [g.step_no, g.steps.map((s) => s.approver_name)]),
      [
        [1, ["Hana", "Khoa"]],
        [2, ["Alice"]],
      ]
    );
  });

  it("is empty without steps", () => {
    assert.deepEqual(currentSteps(bundle({ status: "draft", me: LAN })), []);
  });
});

describe("validateApprovalChain", () => {
  const people = new Map([
    [HANA, { name: "Hana", canSign: false }],
    [KHOA, { name: "Khoa", canSign: false }],
    [ALICE, { name: "Alice", canSign: true }],
  ]);
  const s = (approver_user_id: string, kind: StepKind, extra: Partial<ApprovalChainStepInput> = {}) => ({
    approver_user_id,
    kind,
    ...extra,
  });

  it("accepts the fixture chain", () => {
    assert.deepEqual(
      validateApprovalChain(
        [s(HANA, "review"), s(KHOA, "consult", { parallel_with_previous: true, required: false }), s(ALICE, "sign")],
        people
      ),
      []
    );
    assert.deepEqual(validateApprovalChain([s(ALICE, "sign")], people), []);
  });

  it("needs exactly one signer", () => {
    assert.deepEqual(validateApprovalChain([], people), ["End the chain with exactly one signer"]);
    assert.deepEqual(validateApprovalChain([s(HANA, "review")], people), ["End the chain with exactly one signer"]);
    assert.ok(
      validateApprovalChain([s(ALICE, "sign"), s(HANA, "review"), s(ALICE, "sign")], people).includes(
        "End the chain with exactly one signer"
      )
    );
  });

  it("puts the signer last, in a step of their own", () => {
    assert.deepEqual(validateApprovalChain([s(ALICE, "sign"), s(HANA, "review")], people), ["The signer must be last"]);
    assert.deepEqual(
      validateApprovalChain([s(HANA, "review"), s(ALICE, "sign", { parallel_with_previous: true })], people),
      ["The signer must be last"]
    );
  });

  it("names a signer who cannot sign", () => {
    assert.deepEqual(validateApprovalChain([s(HANA, "review"), s(KHOA, "sign")], people), ["Khoa cannot sign"]);
    assert.deepEqual(validateApprovalChain([s("u-unknown", "sign")], people), ["This person cannot sign"]);
  });

  it("allows at most 10 steps", () => {
    const steps = [...Array.from({ length: 10 }, () => s(HANA, "review")), s(ALICE, "sign")];
    assert.deepEqual(validateApprovalChain(steps, people), ["Add at most 10 steps"]);
    assert.deepEqual(validateApprovalChain(steps.slice(1), people), []);
  });

  it("rejects one person twice in the same step, not in different steps", () => {
    assert.deepEqual(
      validateApprovalChain(
        [s(HANA, "review"), s(HANA, "consult", { parallel_with_previous: true }), s(ALICE, "sign")],
        people
      ),
      ["A person appears twice in the same step"]
    );
    assert.deepEqual(validateApprovalChain([s(HANA, "review"), s(HANA, "format_check"), s(ALICE, "sign")], people), []);
  });

  it("asks for a person on every step", () => {
    assert.deepEqual(validateApprovalChain([s("", "review"), s(ALICE, "sign")], people), [
      "Pick a person for every step",
    ]);
  });
});

describe("chainProgressLabel", () => {
  it("shows the current step and who it waits for", () => {
    assert.equal(
      chainProgressLabel(bundle({ status: "in_review", me: LAN, currentStep: 1, steps: chainRev1("pending", "waiting") })),
      "Step 1 of 2 · waiting for Hana and Khoa"
    );
    const signing = [
      step(1, 1, "review", HANA, "approved"),
      step(1, 1, "consult", KHOA, "skipped"),
      step(1, 2, "sign", ALICE, "pending"),
    ];
    assert.equal(
      chainProgressLabel(bundle({ status: "awaiting_signature", me: LAN, currentStep: 2, steps: signing })),
      "Step 2 of 2 · waiting for Alice"
    );
  });

  it("matches the spec example", () => {
    const steps = [
      step(1, 1, "review", HANA, "approved"),
      step(1, 2, "format_check", "u-lan2", "pending"),
      step(1, 3, "sign", ALICE, "waiting"),
    ];
    steps[1].approver_name = "Lan";
    assert.equal(
      chainProgressLabel(bundle({ status: "in_review", me: CUONG, currentStep: 2, steps })),
      "Step 2 of 3 · waiting for Lan"
    );
  });

  it("shortens long waiting lists", () => {
    const steps = [
      step(1, 1, "consult", HANA, "pending"),
      step(1, 1, "consult", KHOA, "pending"),
      step(1, 1, "consult", CUONG, "pending"),
      step(1, 1, "consult", LAN, "pending"),
      step(1, 2, "sign", ALICE, "waiting"),
    ];
    assert.equal(
      chainProgressLabel(bundle({ status: "in_review", me: LAN, currentStep: 1, steps })),
      "Step 1 of 2 · waiting for Hana, Khoa and 2 more"
    );
  });

  it("describes drafts, with the revision once returned", () => {
    assert.equal(chainProgressLabel(bundle({ status: "draft", me: LAN })), "No approval chain yet");
    assert.equal(
      chainProgressLabel(bundle({ status: "draft", me: LAN, steps: [step(1, 1, "sign", ALICE, "waiting")] })),
      "1 step · not submitted"
    );
    const returned = [
      step(1, 1, "review", HANA, "returned"),
      step(1, 2, "sign", ALICE, "skipped"),
      step(2, 1, "review", HANA, "waiting"),
      step(2, 2, "sign", ALICE, "waiting"),
    ];
    assert.equal(
      chainProgressLabel(bundle({ status: "draft", me: LAN, revision: 2, steps: returned })),
      "Revision 2 · 2 steps · not submitted"
    );
  });

  it("describes the final statuses", () => {
    assert.equal(chainProgressLabel(bundle({ status: "signed", me: LAN })), "Signed · ready to issue");
    assert.equal(chainProgressLabel(bundle({ status: "issued", me: LAN, notation: "01/QĐ-ABC" })), "Issued as 01/QĐ-ABC");
    assert.equal(chainProgressLabel(bundle({ status: "rejected", me: LAN })), "Rejected");
    assert.equal(chainProgressLabel(bundle({ status: "withdrawn", me: LAN })), "Withdrawn");
    assert.equal(chainProgressLabel(bundle({ status: "recalled", me: LAN })), "Recalled");
  });

  it("is empty for incoming documents", () => {
    assert.equal(chainProgressLabel(bundle({ status: "registered", me: LAN, direction: "incoming" })), "");
  });
});
