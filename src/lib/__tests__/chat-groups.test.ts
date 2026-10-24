import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  activeMentions,
  canEditGroup,
  canManageMembers,
  chatTitle,
  filterMembers,
  groupReactions,
  mentionQuery,
  mentionSegments,
  mergeMessages,
  messagePreview,
  personName,
  systemText,
  toTime,
} from "../chat-format.ts";
import { BACKGROUND_PRESETS, backgroundStyle } from "../chat-themes.ts";

describe("names", () => {
  it("prefers the display name, then the e-mail", () => {
    assert.equal(personName({ email: "bob@example.com", display_name: "Bob" }), "Bob");
    assert.equal(personName({ email: "bob@example.com", display_name: null }), "bob@example.com");
    assert.equal(personName(null), "Unknown user");
  });

  it("titles groups, direct chats and notes to self", () => {
    const direct = { kind: "direct", title: null, other_id: "u2", other_email: "bob@example.com", other_name: "Bob" };
    assert.equal(chatTitle({ ...direct }, "me"), "Bob");
    assert.equal(chatTitle({ ...direct, other_id: "me", other_name: null, other_email: "me@example.com" }, "me"), "me@example.com (you)");
    assert.equal(chatTitle({ ...direct, kind: "group", title: "Dự án" }, "me"), "Dự án");
  });
});

describe("previews in groups", () => {
  const base = {
    last_body: null,
    last_file_name: null,
    last_sender_id: "u2",
    last_deleted: false,
    kind: "group",
    last_kind: "message",
    last_sender_name: "Bob",
    last_meta: null,
  };
  it("names the sender and explains system messages", () => {
    assert.equal(messagePreview({ ...base, last_body: "hi" }, "me"), "Bob: hi");
    assert.equal(messagePreview({ ...base, last_sender_id: "me", last_body: "ok" }, "me"), "You: ok");
    assert.equal(
      messagePreview({ ...base, last_kind: "system", last_meta: { type: "rename", title: "Team" } }, "me"),
      'Bob renamed the group to "Team"'
    );
  });
});

describe("systemText", () => {
  const nameOf = (id: string) => ({ u2: "Bob", u3: "Carol" })[id] ?? "a member";
  it("describes group changes", () => {
    assert.equal(systemText({ type: "create", title: "Team" }, "u2", nameOf, "me"), 'Bob created the group "Team"');
    assert.equal(systemText({ type: "add", user_ids: ["u3", "x"] }, "me", nameOf, "me"), "You added Carol, a member");
    assert.equal(systemText({ type: "remove", user_id: "u3" }, "u2", nameOf, "me"), "Bob removed Carol");
    assert.equal(systemText({ type: "role", user_id: "u3", role: "admin" }, "u2", nameOf, "me"), "Bob made Carol an admin");
    assert.equal(systemText({ type: "owner", user_id: "u3" }, "u2", nameOf, "me"), "Bob made Carol the group owner");
    assert.equal(systemText({ type: "pin" }, "u2", nameOf, "me"), "Bob pinned a message");
    assert.equal(systemText({ type: "leave" }, "u3", nameOf, "me"), "Carol left the group");
    assert.equal(systemText(null, "u2", nameOf, "me"), "Bob updated the group");
  });
});

describe("reactions", () => {
  it("counts each emoji in a fixed order and marks mine", () => {
    const summary = groupReactions(
      [
        { emoji: "😆", user_id: "u2" },
        { emoji: "❤️", user_id: "me" },
        { emoji: "❤️", user_id: "u3" },
      ],
      "me"
    );
    assert.deepEqual(summary.map((r) => [r.emoji, r.count, r.mine]), [["❤️", 2, true], ["😆", 1, false]]);
  });
});

describe("mentions", () => {
  const members = [
    { user_id: "u2", name: "Bob Trần", email: "bob@example.com" },
    { user_id: "u3", name: "Carol", email: "carol@example.com" },
  ];
  it("finds the @query at the caret", () => {
    assert.deepEqual(mentionQuery("Hi @bo", 6), { start: 3, query: "bo" });
    assert.deepEqual(mentionQuery("@", 1), { start: 0, query: "" });
    assert.equal(mentionQuery("mail a@b", 8), null);
    assert.equal(mentionQuery("Hi @bob\nthere", 13), null);
  });

  it("filters members without accents or case", () => {
    assert.deepEqual(filterMembers(members, "tran").map((m) => m.user_id), ["u2"]);
    assert.deepEqual(filterMembers(members, "CAROL@").map((m) => m.user_id), ["u3"]);
    assert.equal(filterMembers(members, "").length, 2);
  });

  it("keeps only mentions still in the text and splits text for display", () => {
    const picked = [
      { id: "u2", name: "Bob Trần" },
      { id: "u3", name: "Carol" },
    ];
    assert.deepEqual(activeMentions("Hi @Bob Trần!", picked), ["u2"]);
    assert.deepEqual(mentionSegments("Hi @Bob Trần and @Carol", picked), [
      { text: "Hi " },
      { text: "@Bob Trần", userId: "u2" },
      { text: " and " },
      { text: "@Carol", userId: "u3" },
    ]);
    assert.deepEqual(mentionSegments("no mentions", []), [{ text: "no mentions" }]);
  });
});

describe("timestamps", () => {
  it("compares Postgres, Realtime and browser formats by time, not text", () => {
    assert.equal(toTime("2026-10-24T08:00:00.123456+00:00"), toTime("2026-10-24T08:00:00.123Z"));
    assert.equal(toTime("2026-10-24T08:00:00.5"), Date.parse("2026-10-24T08:00:00.5Z"));
    assert.equal(toTime("2026-10-24T10:00:00+02:00"), Date.parse("2026-10-24T08:00:00Z"));
    assert.equal(toTime(null), 0);
    const merged = mergeMessages(
      [{ id: "b", created_at: "2026-10-24T08:00:00.900Z" }],
      [{ id: "a", created_at: "2026-10-24T08:00:00.123456+00:00" }]
    );
    assert.deepEqual(merged.map((m) => m.id), ["a", "b"]);
  });
});

describe("group permissions", () => {
  it("follows the Zalo-style roles", () => {
    assert.equal(canEditGroup("member", false), true);
    assert.equal(canEditGroup("member", true), false);
    assert.equal(canEditGroup("admin", true), true);
    assert.equal(canEditGroup(null, false), false);
    assert.equal(canManageMembers("admin"), true);
    assert.equal(canManageMembers("member"), false);
  });
});

describe("backgrounds", () => {
  it("resolves presets and uploaded images", () => {
    assert.ok(BACKGROUND_PRESETS.length >= 12);
    assert.ok(backgroundStyle(`preset:${BACKGROUND_PRESETS[0].key}`, () => "")?.background);
    assert.equal(backgroundStyle("preset:nope", () => ""), null);
    assert.equal(backgroundStyle(null, () => ""), null);
    assert.match(String(backgroundStyle("image:groups/g/bg.webp", (p) => `https://cdn/${p}`)?.backgroundImage), /https:\/\/cdn\/groups\/g\/bg\.webp/);
  });
});
