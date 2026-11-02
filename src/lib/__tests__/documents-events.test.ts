import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_EVENT_ICON,
  EVENT_ICON_NAMES,
  changedFieldNames,
  eventIcon,
  eventLabel,
  sentenceCase,
} from "../documents/events.ts";
import { DOC_EVENT_ACTIONS, type DocEventAction } from "../documents/types.ts";

/** A typical data payload per action, as the migrations' doc_log calls write it. */
const SAMPLE_DATA: Record<DocEventAction, Record<string, unknown>> = {
  created: { direction: "incoming" },
  profile_updated: { changed: { subject: ["Old", "New"], due_date: [null, "2026-11-02"] } },
  file_attached: { file_id: "f1", kind: "main", name: "Quyết định.pdf" },
  file_detached: { file_id: "f1", kind: "attachment", name: "Phụ lục.docx" },
  opinion_added: { opinion_id: "o1", kind: "proposal" },
  access_granted: { user_id: "u1", access: "edit" },
  access_revoked: { user_id: "u1" },
  registered: { arrival_number: 12, register_id: "r1" },
  submitted: { to_user_id: "u1", to_name: "Lan" },
  returned_to_clerk: { reason: "Wrong register" },
  assigned: {
    parent_id: null,
    items: [
      { assignment_id: "a1", role: "lead", user_id: "u1", name: "Lan", due_date: "2026-11-05" },
      { assignment_id: "a2", role: "support", department_id: "d1", name: "Phòng Kế toán" },
    ],
  },
  seen: { count: 1 },
  assignment_updated: { assignment_id: "a1", status: "done" },
  assignment_revoked: { assignment_id: "a1", count: 2 },
  completed: {},
  reopened: { reason: "More work" },
  cancelled: { reason: "Sent by mistake", arrival_number: 3 },
  chain_set: { revision: 1, steps: 3, step_count: 2 },
  submitted_for_approval: { revision: 1, step_no: 1 },
  approved: { step_no: 1, kind: "review", opinion_id: null },
  returned: { step_no: 2, revision: 2, opinion_id: "o2" },
  rejected: { step_no: 2, opinion_id: "o3" },
  signed: { authority: "KT", checksum: "abc" },
  issued: { number: 1, notation: "01/QĐ-ABC", register_id: "r1", recipients: 4 },
  manual_number_override: { number: 15, register_id: "r1" },
  recalled: { reason: "Superseded" },
  withdrawn: {},
  follow_up_created: { kind: "reply", source_id: "d0" },
  reassigned: { assignment_id: "a1", role: "lead", from: "u1", to: "u2", reason: "offboarding" },
  filed: { dossier_id: "x1", code: "HS-01" },
  unfiled: { dossier_id: "x1", code: "HS-01" },
  archived: { dossier_id: "x1", code: "HS-01" },
};

const EXPECTED: Record<DocEventAction, string> = {
  created: "Created",
  profile_updated: "Updated Subject, Due date",
  file_attached: "Attached Main file (Tệp chính) “Quyết định.pdf”",
  file_detached: "Removed Attachment (Phụ lục) “Phụ lục.docx”",
  opinion_added: "Added an opinion · Proposal (Đề xuất)",
  access_granted: "Shared with edit access",
  access_revoked: "Removed someone's access",
  registered: "Registered as arrival no. 12",
  submitted: "Submitted to Lan",
  returned_to_clerk: "Returned to the clerk: Wrong register",
  assigned: "Assigned: Lan – Lead (Chủ trì), Phòng Kế toán – Support (Phối hợp)",
  seen: "Opened",
  assignment_updated: "Reported the result",
  assignment_revoked: "Withdrew an assignment",
  completed: "Completed",
  reopened: "Reopened: More work",
  cancelled: "Cancelled: Sent by mistake",
  chain_set: "Set the approval chain (2 steps)",
  submitted_for_approval: "Sent for approval",
  approved: "Approved",
  returned: "Returned for revision",
  rejected: "Rejected",
  signed: "Signed (KT.)",
  issued: "Issued as 01/QĐ-ABC",
  manual_number_override: "Number set by hand: 15",
  recalled: "Recalled: Superseded",
  withdrawn: "Withdrawn",
  follow_up_created: "Drafted as a reply to another document",
  reassigned: "Assignment handed over (member left)",
  filed: "Filed in dossier HS-01",
  unfiled: "Removed from dossier HS-01",
  archived: "Archived with dossier HS-01",
};

describe("eventLabel", () => {
  for (const action of DOC_EVENT_ACTIONS) {
    it(`labels '${action}' from its data`, () => {
      assert.equal(eventLabel({ action, data: SAMPLE_DATA[action] }), EXPECTED[action]);
    });
  }

  it("gives every canonical action a non-empty label without data", () => {
    for (const action of DOC_EVENT_ACTIONS) {
      for (const data of [{}, null, undefined]) {
        const label = eventLabel({ action, data });
        assert.ok(label.length > 0, `${action} has an empty label`);
        assert.doesNotMatch(label, /undefined|null|\[object/, `${action}: ${label}`);
      }
    }
  });

  it("mentions an allowed duplicate on registration", () => {
    assert.equal(
      eventLabel({ action: "registered", data: { arrival_number: 7, duplicate_reason: "Second copy by post" } }),
      "Registered as arrival no. 7 (duplicate allowed: Second copy by post)"
    );
  });

  it("reads the submit target, sub-assignments and assignment statuses", () => {
    assert.equal(eventLabel({ action: "submitted", data: {} }), "Submitted to a leader");
    assert.equal(eventLabel({ action: "assigned", data: { parent_id: "a1", items: [] } }), "Sub-assigned");
    assert.equal(eventLabel({ action: "assignment_updated", data: { status: "in_progress" } }), "Started processing");
    assert.equal(
      eventLabel({ action: "assignment_updated", data: { status: "returned", reason: "Not our department" } }),
      "Returned the assignment: Not our department"
    );
  });

  it("names follow-ups, signing without authority and step reassignment", () => {
    assert.equal(eventLabel({ action: "created", data: { follow_up: "correction" } }), "Created as a correction");
    assert.equal(
      eventLabel({ action: "follow_up_created", data: { kind: "replacement", document_id: "d2" } }),
      "A replacement was drafted"
    );
    assert.equal(eventLabel({ action: "signed", data: { authority: "" } }), "Signed");
    assert.equal(
      eventLabel({ action: "reassigned", data: { approval_step_id: "s1", reason: "offboarding" } }),
      "Approval step handed over (member left)"
    );
    assert.equal(eventLabel({ action: "approved", data: { kind: "consult" } }), "Approved · Consult (Xin ý kiến)");
    assert.equal(eventLabel({ action: "completed", data: { override: true } }), "Completed (by a leader)");
    assert.equal(eventLabel({ action: "completed", data: { result_note: "Đã gửi dự toán" } }), "Completed: Đã gửi dự toán");
  });

  it("shortens very long reasons", () => {
    const label = eventLabel({ action: "recalled", data: { reason: "x".repeat(500) } });
    assert.ok(label.length < 230);
    assert.ok(label.endsWith("…"));
  });

  it("falls back to sentence case for unknown actions", () => {
    assert.equal(eventLabel({ action: "legal_hold_set", data: {} }), "Legal hold set");
    assert.equal(eventLabel({ action: "", data: {} }), "Event");
  });
});

describe("changedFieldNames", () => {
  it("names the changed profile keys once each, unknown keys as words", () => {
    assert.deepEqual(
      changedFieldNames({
        changed: { issuing_org_name: [null, "A"], external_org_id: [null, "x"], retention_code_id: [null, "r"] },
      }),
      ["Issuing organisation", "Retention code"]
    );
  });

  it("ignores missing or malformed data", () => {
    assert.deepEqual(changedFieldNames({}), []);
    assert.deepEqual(changedFieldNames(null), []);
    assert.deepEqual(changedFieldNames({ changed: ["subject"] }), []);
    assert.equal(eventLabel({ action: "profile_updated", data: {} }), "Updated details");
  });
});

describe("eventIcon", () => {
  it("has a known icon for every canonical action", () => {
    for (const action of DOC_EVENT_ACTIONS) {
      const icon = eventIcon(action);
      assert.notEqual(icon, DEFAULT_EVENT_ICON, `${action} uses the fallback icon`);
      assert.ok(EVENT_ICON_NAMES.includes(icon), `${action}: ${icon} is not listed`);
    }
  });

  it("falls back for unknown actions, including prototype names", () => {
    assert.equal(eventIcon("something_new"), DEFAULT_EVENT_ICON);
    assert.equal(eventIcon("toString"), DEFAULT_EVENT_ICON);
    assert.ok(EVENT_ICON_NAMES.includes(DEFAULT_EVENT_ICON));
  });
});

describe("sentenceCase", () => {
  it("turns snake case into a sentence", () => {
    assert.equal(sentenceCase("manual_number_override"), "Manual number override");
    assert.equal(sentenceCase("  "), "Event");
  });
});
