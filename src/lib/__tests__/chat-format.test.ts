import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dayLabel, groupByDay, mergeMessages, messagePreview } from "../chat-format.ts";

const NOW = new Date(2026, 9, 21, 15, 0);

describe("messagePreview", () => {
  const base = { last_body: null, last_file_name: null, last_sender_id: "u2", last_deleted: false };
  it("shows text, files, unsent and own messages", () => {
    assert.equal(messagePreview({ ...base, last_body: "Chào\n  bạn" }, "me"), "Chào bạn");
    assert.equal(messagePreview({ ...base, last_file_name: "plan.pdf" }, "me"), "📎 plan.pdf");
    assert.equal(messagePreview({ ...base, last_sender_id: "me", last_body: "ok" }, "me"), "You: ok");
    assert.equal(messagePreview({ ...base, last_deleted: true }, "me"), "Message unsent");
    assert.equal(messagePreview({ ...base, last_sender_id: null }, "me"), "No messages yet");
  });
});

describe("days", () => {
  it("labels today and yesterday", () => {
    assert.equal(dayLabel(new Date(2026, 9, 21, 8).toISOString(), NOW), "Today");
    assert.equal(dayLabel(new Date(2026, 9, 20, 23).toISOString(), NOW), "Yesterday");
    assert.equal(dayLabel(new Date(2026, 9, 1).toISOString(), NOW), "Oct 1, 2026");
  });

  it("groups consecutive messages of the same day", () => {
    const at = (d: number, h: number) => ({ created_at: new Date(2026, 9, d, h).toISOString() });
    const groups = groupByDay([at(20, 9), at(20, 10), at(21, 8)], NOW);
    assert.deepEqual(groups.map((g) => [g.label, g.items.length]), [["Yesterday", 2], ["Today", 1]]);
  });
});

describe("mergeMessages", () => {
  it("dedupes by id, keeps the newest data and sorts oldest first", () => {
    const a = { id: "a", created_at: "2026-10-21T01:00:00Z", body: "old" };
    const b = { id: "b", created_at: "2026-10-21T02:00:00Z", body: "x" };
    const merged = mergeMessages([b, a], [{ ...a, body: "edited" }]);
    assert.deepEqual(merged.map((m) => [m.id, m.body]), [["a", "edited"], ["b", "x"]]);
  });
});
