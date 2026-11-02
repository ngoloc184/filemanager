import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  BAN_DURATION,
  parseOffboardRequest,
  plural,
  previewLines,
  resultLines,
  validateOffboard,
  type OffboardingPreview,
  type OffboardingResult,
} from "../offboarding.ts";

const ME = "aaaaaaaa-0000-0000-0000-00000000000a";
const BOB = "bbbbbbbb-0000-0000-0000-00000000000b";
const CAROL = "cccccccc-0000-0000-0000-00000000000c";

const emptyPreview: OffboardingPreview = {
  files: 0,
  folders: 0,
  bytes: 0,
  open_assignments: 0,
  pending_steps: 0,
  presented_documents: 0,
  draft_documents: 0,
  headed_departments: 0,
  owned_chat_groups: 0,
  register_roles: 0,
  dossiers: 0,
};

const emptyResult: OffboardingResult = {
  files: 0,
  folders: 0,
  renamed_folders: 0,
  shares_removed: 0,
  chat_groups: 0,
  assignments: 0,
  approval_steps: 0,
  skipped_steps: 0,
  presented_documents: 0,
  draft_documents: 0,
  departments: 0,
  register_roles: 0,
  dossiers: 0,
  push_subscriptions: 0,
};

describe("plural", () => {
  it("uses the singular only for exactly one", () => {
    assert.equal(plural(1, "file"), "1 file");
    assert.equal(plural(0, "file"), "0 files");
    assert.equal(plural(2, "dossier (hồ sơ)", "dossiers (hồ sơ)"), "2 dossiers (hồ sơ)");
    assert.equal(plural(1200, "file"), "1,200 files");
  });
});

describe("previewLines", () => {
  it("is empty when there is nothing to move", () => {
    assert.deepEqual(previewLines(emptyPreview, "Carol"), []);
  });

  it("joins files, folders and their size in one line", () => {
    const lines = previewLines(
      { ...emptyPreview, files: 12, folders: 3, bytes: 1.2 * 1024 * 1024 * 1024 },
      "Carol"
    );
    assert.deepEqual(lines, ["12 files and 3 folders (1.2 GB) will move to Carol"]);
  });

  it("pluralises each count and skips zeros", () => {
    const lines = previewLines(
      {
        ...emptyPreview,
        files: 1,
        open_assignments: 4,
        pending_steps: 1,
        presented_documents: 2,
        headed_departments: 1,
        owned_chat_groups: 2,
        register_roles: 1,
        dossiers: 3,
      },
      "Carol"
    );
    assert.deepEqual(lines, [
      "1 file will move to Carol",
      "4 open document tasks will be reassigned to Carol",
      "1 approval step will be handed to Carol",
      "2 documents awaiting their decision will be presented to Carol",
      "1 department they head will be headed by Carol",
      "2 chat groups they own will get a new owner (Carol if they are in the group, else a group admin)",
      "1 register (sổ) role will move to Carol",
      "3 dossiers (hồ sơ) will move to Carol",
    ]);
  });

  it("shows folders alone, without a size when there are no bytes", () => {
    assert.deepEqual(previewLines({ ...emptyPreview, folders: 1 }, "Carol"), ["1 folder will move to Carol"]);
  });

  it("includes drafts and tolerates numbers sent as strings or missing keys", () => {
    const raw = { ...emptyPreview, draft_documents: 2, files: "3" } as unknown as OffboardingPreview;
    delete (raw as Partial<OffboardingPreview>).dossiers;
    assert.deepEqual(previewLines(raw, "Carol"), [
      "3 files will move to Carol",
      "2 draft documents will move to Carol",
    ]);
  });

  it("falls back to a neutral name", () => {
    assert.deepEqual(previewLines({ ...emptyPreview, files: 2 }, "  "), ["2 files will move to the successor"]);
  });
});

describe("resultLines", () => {
  it("summarises what moved and skips zeros", () => {
    const lines = resultLines(
      { ...emptyResult, files: 2, folders: 1, renamed_folders: 1, assignments: 1, skipped_steps: 2, push_subscriptions: 1 },
      "Carol"
    );
    assert.deepEqual(lines, [
      "2 files and 1 folder moved to Carol",
      '1 folder was renamed to avoid a name clash ("… (from …)")',
      "1 document task reassigned",
      "2 approval steps skipped (Carol already had it)",
      "1 device stopped receiving notifications",
    ]);
  });

  it("is empty when nothing moved", () => {
    assert.deepEqual(resultLines(emptyResult, "Carol"), []);
  });
});

describe("validateOffboard", () => {
  it("needs the leaver first", () => {
    assert.equal(validateOffboard(null, CAROL, ME), "Pick the person who is leaving");
  });
  it("refuses offboarding yourself", () => {
    assert.equal(validateOffboard(ME, CAROL, ME), "You cannot offboard yourself");
  });
  it("needs a successor", () => {
    assert.equal(validateOffboard(BOB, null, ME), "Pick a successor");
    assert.equal(validateOffboard(BOB, "", ME), "Pick a successor");
  });
  it("needs a different successor", () => {
    assert.equal(validateOffboard(BOB, BOB, ME), "The successor must be a different person");
  });
  it("accepts a valid choice, also with yourself as the successor", () => {
    assert.equal(validateOffboard(BOB, CAROL, ME), null);
    assert.equal(validateOffboard(BOB, ME, ME), null);
  });
});

describe("parseOffboardRequest", () => {
  it("accepts ids and the sign-in flag", () => {
    assert.deepEqual(parseOffboardRequest({ userId: BOB, successorId: CAROL, blockSignIn: false }), {
      userId: BOB,
      successorId: CAROL,
      blockSignIn: false,
    });
  });
  it("blocks sign-in by default and lower-cases ids", () => {
    assert.deepEqual(parseOffboardRequest({ userId: BOB.toUpperCase(), successorId: CAROL }), {
      userId: BOB,
      successorId: CAROL,
      blockSignIn: true,
    });
  });
  it("rejects bad bodies", () => {
    assert.deepEqual(parseOffboardRequest(null), { error: "Invalid request" });
    assert.deepEqual(parseOffboardRequest([BOB]), { error: "Invalid request" });
    assert.deepEqual(parseOffboardRequest({ userId: "x", successorId: CAROL }), {
      error: "Pick the person who is leaving",
    });
    assert.deepEqual(parseOffboardRequest({ userId: BOB }), { error: "Pick a successor" });
    assert.deepEqual(parseOffboardRequest({ userId: BOB, successorId: CAROL, blockSignIn: "yes" }), {
      error: "Invalid request",
    });
    assert.deepEqual(parseOffboardRequest({ userId: BOB, successorId: BOB.toUpperCase() }), {
      error: "The successor must be a different person",
    });
  });
});

describe("BAN_DURATION", () => {
  it("uses an hour unit the auth API accepts", () => {
    assert.match(BAN_DURATION, /^\d+h$/);
  });
});
