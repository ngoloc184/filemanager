import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { groupByDay, notificationIcon, safeLink } from "../notifications.ts";

// local times, so the test does not depend on the machine's time zone
const at = (y: number, m: number, d: number, h = 12, min = 0) => new Date(y, m - 1, d, h, min).toISOString();

describe("groupByDay", () => {
  const now = new Date(2026, 9, 30, 9, 30); // 30 Oct 2026, 09:30 local

  it("splits rows into Today, Yesterday and Earlier and keeps their order", () => {
    const rows = [
      { id: "a", created_at: at(2026, 10, 30, 9, 0) },
      { id: "b", created_at: at(2026, 10, 30, 0, 0) },
      { id: "c", created_at: at(2026, 10, 29, 23, 59) },
      { id: "d", created_at: at(2026, 10, 29, 0, 0) },
      { id: "e", created_at: at(2026, 10, 28, 23, 59) },
      { id: "f", created_at: at(2025, 1, 1) },
    ];
    assert.deepEqual(
      groupByDay(rows, now).map((g) => [g.label, g.items.map((r) => r.id)]),
      [
        ["Today", ["a", "b"]],
        ["Yesterday", ["c", "d"]],
        ["Earlier", ["e", "f"]],
      ]
    );
  });

  it("leaves out empty groups", () => {
    assert.deepEqual(groupByDay([], now), []);
    const groups = groupByDay([{ created_at: at(2026, 10, 1) }], now);
    assert.deepEqual(groups.map((g) => g.label), ["Earlier"]);
  });

  it("handles the first day of a month and unreadable dates", () => {
    const first = new Date(2026, 10, 1, 8, 0); // 1 Nov
    const groups = groupByDay([{ created_at: at(2026, 10, 31, 22) }, { created_at: "not a date" }], first);
    assert.deepEqual(groups.map((g) => [g.label, g.items.length]), [
      ["Yesterday", 1],
      ["Earlier", 1],
    ]);
  });

  it("counts something from the future (clock skew) as today", () => {
    assert.equal(groupByDay([{ created_at: at(2026, 10, 30, 10, 0) }], now)[0].label, "Today");
  });
});

describe("safeLink", () => {
  it("keeps in-app paths", () => {
    assert.equal(safeLink("/shared"), "/shared");
    assert.equal(safeLink("/dashboard?folder=abc"), "/dashboard?folder=abc");
    assert.equal(safeLink("/documents/123#history"), "/documents/123#history");
  });

  it("rejects other sites and anything that is not a path", () => {
    assert.equal(safeLink("//evil"), "/dashboard");
    assert.equal(safeLink("//evil.example/x"), "/dashboard");
    assert.equal(safeLink("/\\evil.example"), "/dashboard");
    assert.equal(safeLink("https://x"), "/dashboard");
    assert.equal(safeLink("javascript:alert(1)"), "/dashboard");
    assert.equal(safeLink("shared"), "/dashboard");
    assert.equal(safeLink("/a\nb"), "/dashboard");
    assert.equal(safeLink("/\t/evil.example"), "/dashboard");
    assert.equal(safeLink(""), "/dashboard");
    assert.equal(safeLink(null), "/dashboard");
    assert.equal(safeLink(undefined), "/dashboard");
  });
});

describe("notificationIcon", () => {
  it("maps the kind prefix to a lucide icon", () => {
    assert.equal(notificationIcon("share.file"), "Share2");
    assert.equal(notificationIcon("share.folder"), "Share2");
    assert.equal(notificationIcon("comment"), "MessageSquare");
    assert.equal(notificationIcon("document.assigned"), "FileText");
    assert.equal(notificationIcon("org.invited"), "Building2");
    assert.equal(notificationIcon("chat.mention"), "Bell");
    assert.equal(notificationIcon("constructor"), "Bell");
  });
});
