import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { notificationContent, notifyChannels } from "../chat-notify.ts";

const base = {
  event: "INSERT",
  senderId: "them",
  myId: "me",
  onScreen: false,
  pageActive: true,
  enabled: true,
  permission: "granted" as const,
};

describe("notifyChannels", () => {
  it("ignores my own messages and edits/unsends", () => {
    assert.deepEqual(notifyChannels({ ...base, senderId: "me" }), { toast: false, system: false });
    assert.deepEqual(notifyChannels({ ...base, event: "UPDATE" }), { toast: false, system: false });
    assert.deepEqual(notifyChannels({ ...base, event: "DELETE" }), { toast: false, system: false });
  });

  it("uses the in-app toast while the user is looking at the app", () => {
    assert.deepEqual(notifyChannels(base), { toast: true, system: false });
    assert.deepEqual(notifyChannels({ ...base, onScreen: true }), { toast: false, system: false });
  });

  it("uses a system notification when the tab is hidden or the window is not focused", () => {
    assert.deepEqual(notifyChannels({ ...base, pageActive: false }), { toast: true, system: true });
    assert.deepEqual(notifyChannels({ ...base, pageActive: false, onScreen: true }), { toast: false, system: true });
  });

  it("respects the account switch and the browser permission", () => {
    assert.equal(notifyChannels({ ...base, pageActive: false, enabled: false }).system, false);
    assert.equal(notifyChannels({ ...base, pageActive: false, permission: "default" }).system, false);
    assert.equal(notifyChannels({ ...base, pageActive: false, permission: "denied" }).system, false);
    assert.equal(notifyChannels({ ...base, pageActive: false, permission: "unsupported" }).system, false);
  });
});

describe("notificationContent", () => {
  it("shows the sender and a one-line preview", () => {
    assert.deepEqual(notificationContent({ senderEmail: "bob@example.com", body: "  Hi\n\nthere  ", fileName: null }), {
      title: "bob@example.com",
      body: "Hi there",
    });
  });

  it("describes files and falls back when details are missing", () => {
    assert.equal(notificationContent({ senderEmail: null, body: null, fileName: "report.pdf" }).body, "📎 report.pdf");
    assert.equal(notificationContent({ senderEmail: null, body: null, fileName: null }).title, "New chat message");
    assert.equal(notificationContent({ senderEmail: null, body: null, fileName: null }).body, "Sent you a message");
  });

  it("titles group messages with the group and names the sender", () => {
    assert.deepEqual(notificationContent({ senderEmail: "Bob", body: "hi", fileName: null, group: "Team" }), {
      title: "Team",
      body: "Bob: hi",
    });
    assert.deepEqual(notificationContent({ senderEmail: "Bob", body: "@Alice xem nhé", fileName: null, group: "Team", mentioned: true }), {
      title: "Team",
      body: "Bob mentioned you: @Alice xem nhé",
    });
  });

  it("keeps long messages short", () => {
    const { body } = notificationContent({ senderEmail: "a@b.co", body: "x".repeat(500), fileName: null });
    assert.ok(body.length <= 140);
    assert.ok(body.endsWith("…"));
  });
});
