import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ACTION_COPY,
  ACTION_PRIORITY,
  SIGNER_AUTHORITY_OPTIONS,
  actionCopy,
  barActions,
  primaryAction,
  type DocumentAction,
} from "../documents/action-copy.ts";
import { INCOMING_ACTIONS, type IncomingAction } from "../documents/incoming.ts";
import type { OutgoingAction } from "../documents/outgoing.ts";
import { SIGNER_AUTHORITIES } from "../documents/types.ts";

// outgoing.ts has no runtime list of its keys; this one is checked against the
// type both ways, so adding an action there without copy fails tsc and here.
const OUTGOING_ACTIONS = [
  "edit",
  "set_chain",
  "submit",
  "approve",
  "return",
  "reject",
  "sign",
  "issue",
  "recall",
  "withdraw",
  "reply",
  "replacement",
  "correction",
  "upload_signed",
  "share_draft",
] as const satisfies readonly OutgoingAction[];
type MissingOutgoing = Exclude<OutgoingAction, (typeof OUTGOING_ACTIONS)[number]>;
const outgoingComplete: MissingOutgoing extends never ? true : false = true;

const ALL_ACTIONS: DocumentAction[] = [...new Set<DocumentAction>([...INCOMING_ACTIONS, ...OUTGOING_ACTIONS])];

describe("ACTION_COPY", () => {
  it("has copy for every incoming and outgoing action key", () => {
    assert.equal(outgoingComplete, true);
    for (const action of ALL_ACTIONS) {
      const copy = ACTION_COPY[action];
      assert.ok(copy, `missing copy for ${action}`);
      assert.ok(copy.label.trim().length > 0, `empty label for ${action}`);
      assert.ok(copy.description.trim().length > 0, `empty description for ${action}`);
      assert.ok(["primary", "default", "danger"].includes(copy.tone), `bad tone for ${action}`);
    }
    assert.deepEqual(Object.keys(ACTION_COPY).sort(), [...ALL_ACTIONS].sort());
  });

  it("puts the Vietnamese term in parentheses in every label", () => {
    for (const action of ALL_ACTIONS) {
      assert.match(ACTION_COPY[action].label, /^[^()]+ \([^()]+\)$/, action);
    }
    assert.equal(ACTION_COPY.assign.label, "Assign (Giao xử lý)");
    assert.equal(ACTION_COPY.sign.label, "Sign (Ký duyệt)");
    assert.equal(ACTION_COPY.issue.label, "Issue (Phát hành)");
    assert.equal(ACTION_COPY.recall.label, "Recall (Thu hồi)");
  });

  it("marks reject, recall, cancel and withdraw as danger and nothing else", () => {
    const danger = ALL_ACTIONS.filter((a) => ACTION_COPY[a].tone === "danger").sort();
    assert.deepEqual(danger, ["cancel", "recall", "reject", "withdraw"]);
  });

  it("uses the incoming wording for submit on incoming documents only", () => {
    assert.match(actionCopy("submit", "incoming").label, /Trình lãnh đạo/);
    assert.match(actionCopy("submit", "outgoing").label, /Trình ký/);
    assert.match(actionCopy("submit", "internal").label, /Trình ký/);
    assert.equal(actionCopy("assign", "incoming"), ACTION_COPY.assign);
    assert.equal(actionCopy("sign", null), ACTION_COPY.sign);
  });
});

describe("primaryAction", () => {
  it("lists every action exactly once in the priority order", () => {
    assert.equal(new Set(ACTION_PRIORITY).size, ACTION_PRIORITY.length);
    assert.deepEqual([...ACTION_PRIORITY].sort(), [...ALL_ACTIONS].sort());
  });

  it("follows register, sign, approve, complete, assign, finish, issue, submit, set_chain", () => {
    const order: DocumentAction[] = [
      "register",
      "sign",
      "approve",
      "complete",
      "assign",
      "finish",
      "issue",
      "submit",
      "set_chain",
    ];
    for (let i = 0; i < order.length; i++) {
      // the rest of the list, shuffled so input order cannot decide
      const rest = order.slice(i).reverse();
      assert.equal(primaryAction(rest), order[i], `from ${rest.join(", ")}`);
    }
    assert.deepEqual(ACTION_PRIORITY.slice(0, order.length), order);
  });

  it("picks the main step of real action lists", () => {
    // clerk on an incoming draft
    assert.equal(primaryAction<IncomingAction>(["register", "cancel", "edit"]), "register");
    // clerk on a registered document: present it or assign it directly
    assert.equal(primaryAction<IncomingAction>(["submit", "assign", "cancel", "edit", "reply"]), "assign");
    // leader after the lead reported: complete, not another assignment
    assert.equal(primaryAction<IncomingAction>(["assign", "revoke", "complete", "reply"]), "complete");
    // the lead who reported (no assign right) completes too
    assert.equal(primaryAction<IncomingAction>(["complete", "reply"]), "complete");
    // leader before the lead reports: complete is only an override, assign stays main
    assert.equal(
      primaryAction<IncomingAction>(["assign", "revoke", "complete", "reply"], { leadReported: false }),
      "assign"
    );
    assert.equal(
      primaryAction<IncomingAction>(["assign", "revoke", "complete", "reply"], { leadReported: true }),
      "complete"
    );
    // nothing ranks above it but assign: without assign, complete is still main
    assert.equal(primaryAction<IncomingAction>(["complete", "finish", "reply"], { leadReported: false }), "complete");
    // leader on a submitted document: complete is not offered yet, assign stays main
    assert.equal(primaryAction<IncomingAction>(["assign", "return_to_clerk", "reply"]), "assign");
    // staff with an open lead assignment
    assert.equal(
      primaryAction<IncomingAction>(["sub_assign", "start", "finish", "return_assignment", "reply"]),
      "finish"
    );
    // author of an outgoing draft
    assert.equal(primaryAction<OutgoingAction>(["edit", "set_chain", "submit", "share_draft", "withdraw"]), "submit");
    // signer
    assert.equal(primaryAction<OutgoingAction>(["sign", "return", "reject"]), "sign");
    // clerk on a signed document
    assert.equal(primaryAction<OutgoingAction>(["edit", "issue", "upload_signed"]), "issue");
    // issued: the follow-ups, not recall
    assert.equal(
      primaryAction<OutgoingAction>(["upload_signed", "recall", "reply", "replacement", "correction"]),
      "upload_signed"
    );
    assert.equal(primaryAction<OutgoingAction>(["recall", "reply", "replacement", "correction"]), "reply");
  });

  it("never makes a danger action the main button", () => {
    assert.equal(primaryAction<OutgoingAction>(["withdraw"]), null);
    assert.equal(primaryAction<OutgoingAction>(["reject", "recall", "withdraw"]), null);
    assert.equal(primaryAction<IncomingAction>(["cancel", "revoke"]), "revoke");
    assert.equal(primaryAction([]), null);
  });
});

describe("barActions", () => {
  it("collapses start, finish and return_assignment into one entry", () => {
    assert.deepEqual(
      barActions<IncomingAction>(["sub_assign", "start", "finish", "return_assignment", "reply"]),
      ["sub_assign", "finish", "reply"]
    );
    assert.deepEqual(barActions<IncomingAction>(["finish", "return_assignment"]), ["finish"]);
  });

  it("keeps other lists as they are", () => {
    const outgoing: OutgoingAction[] = ["edit", "set_chain", "submit", "share_draft", "withdraw"];
    assert.deepEqual(barActions(outgoing), outgoing);
    assert.deepEqual(barActions([]), []);
  });
});

describe("SIGNER_AUTHORITY_OPTIONS", () => {
  it("offers every signer authority once, the head first", () => {
    assert.deepEqual(
      SIGNER_AUTHORITY_OPTIONS.map((o) => o.value),
      [...SIGNER_AUTHORITIES]
    );
    assert.equal(SIGNER_AUTHORITY_OPTIONS[0].value, "");
    for (const o of SIGNER_AUTHORITY_OPTIONS) assert.ok(o.label.trim().length > 0);
  });
});
