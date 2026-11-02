import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { STEP_STATUS_LABELS, frozenFileLabel, stepStatusLabel } from "../documents/labels.ts";
import { INCOMING_STATUSES, OUTGOING_STATUSES } from "../documents/types.ts";

describe("stepStatusLabel", () => {
  it("reads 'Signed (Đã ký)' for an approved sign step", () => {
    assert.equal(stepStatusLabel("sign", "approved"), "Signed (Đã ký)");
  });

  it("keeps the step status label otherwise", () => {
    assert.equal(stepStatusLabel("review", "approved"), STEP_STATUS_LABELS.approved);
    assert.equal(stepStatusLabel("consult", "approved"), STEP_STATUS_LABELS.approved);
    assert.equal(stepStatusLabel("sign", "pending"), STEP_STATUS_LABELS.pending);
    assert.equal(stepStatusLabel("sign", "returned"), STEP_STATUS_LABELS.returned);
    assert.equal(stepStatusLabel("sign", "mystery"), "mystery");
  });
});

describe("frozenFileLabel", () => {
  it("words the lock by the document's status", () => {
    assert.equal(frozenFileLabel("registered"), "Locked after registration (vào sổ)");
    assert.equal(frozenFileLabel("in_progress"), "Locked after registration (vào sổ)");
    assert.equal(frozenFileLabel("in_review"), "Locked while in review (đang trình ký)");
    assert.equal(frozenFileLabel("awaiting_signature"), "Locked while in review (đang trình ký)");
    assert.equal(frozenFileLabel("signed"), "Locked after signing (đã ký)");
    assert.equal(frozenFileLabel("issued"), "Locked after issue (phát hành)");
  });

  it("has a label for every status and a fallback", () => {
    for (const status of [...INCOMING_STATUSES, ...OUTGOING_STATUSES]) {
      assert.match(frozenFileLabel(status), /^Locked/, status);
    }
    assert.equal(frozenFileLabel(null), "Locked (đã khóa)");
    assert.equal(frozenFileLabel("unknown"), "Locked (đã khóa)");
  });
});
