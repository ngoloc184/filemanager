import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chatPushPayload, notificationContent, notifyChannels } from "../chat-notify.ts";

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

  it("notifies the device even while the app is in use, unless that conversation is on screen", () => {
    assert.deepEqual(notifyChannels(base), { toast: true, system: true });
    assert.deepEqual(notifyChannels({ ...base, onScreen: true }), { toast: false, system: false });
    // the conversation is open but the tab is in the background
    assert.deepEqual(notifyChannels({ ...base, pageActive: false, onScreen: true }), { toast: false, system: true });
  });

  it("leaves device notifications to Web Push when this browser is subscribed", () => {
    assert.deepEqual(notifyChannels({ ...base, pushActive: true }), { toast: true, system: false });
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

  it("describes stickers", () => {
    assert.equal(notificationContent({ senderEmail: "Bob", body: null, fileName: null, sticker: true }).body, "Sent a sticker");
    assert.equal(notificationContent({ senderEmail: "Bob", body: null, fileName: null, sticker: true, group: "Team" }).body, "Bob: Sent a sticker");
  });

  it("keeps long messages short", () => {
    const { body } = notificationContent({ senderEmail: "a@b.co", body: "x".repeat(500), fileName: null });
    assert.ok(body.length <= 140);
    assert.ok(body.endsWith("…"));
  });
});

describe("chatPushPayload", () => {
  it("builds what the service worker shows, per recipient", () => {
    const message = { id: "m1", conversation_id: "c1", body: "Chào @Alice", file_name: null, mentions: ["alice"] };
    assert.deepEqual(chatPushPayload({ message, senderName: "Bob", group: "Team", recipientId: "alice" }), {
      title: "Team",
      body: "Bob mentioned you: Chào @Alice",
      tag: "chat-m1",
      conversationId: "c1",
    });
    assert.equal(chatPushPayload({ message, senderName: "Bob", group: "Team", recipientId: "carol" }).body, "Bob: Chào @Alice");
    assert.equal(chatPushPayload({ message, senderName: "Bob", group: null, recipientId: "carol" }).title, "Bob");
  });
});
