import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  counterpart,
  csvFileName,
  emptyMessage,
  formatDate,
  formatDocNumber,
  inboxSearch,
  pageCount,
  pageRangeText,
  rowTone,
  urgencyTone,
  viewCount,
} from "../documents/table-format.ts";
import { EMPTY_DASHBOARD, DOCUMENT_VIEW_KEYS, type DocumentSearchRow } from "../documents/filters.ts";

function row(overrides: Partial<DocumentSearchRow> = {}): DocumentSearchRow {
  return {
    id: "d1",
    direction: "incoming",
    status: "in_progress",
    subject: "Hợp đồng thuê văn phòng",
    notation: "12/CV-XYZ",
    number: null,
    arrival_number: 7,
    arrival_date: "2026-10-05",
    issued_date: "2026-10-01",
    issuing_org_name: "Công ty XYZ",
    type_name: "Công văn",
    urgency: "normal",
    confidentiality: "normal",
    due_date: null,
    my_due_date: null,
    updated_at: "2026-10-05T03:00:00Z",
    created_at: "2026-10-05T03:00:00Z",
    recipients_summary: null,
    total_count: 1,
    ...overrides,
  };
}

describe("formatDocNumber", () => {
  it("shows the arrival number and the sender's notation of a registered incoming document", () => {
    assert.equal(formatDocNumber(row()), "Đến 7 · 12/CV-XYZ");
  });

  it("shows only the arrival number when the sender gave no notation", () => {
    assert.equal(formatDocNumber(row({ notation: null })), "Đến 7");
    assert.equal(formatDocNumber(row({ notation: "  " })), "Đến 7");
  });

  it("shows the notation of an issued outgoing or internal document", () => {
    const issued = { direction: "outgoing", status: "issued", arrival_number: null, notation: "01/QĐ-ABC" } as const;
    assert.equal(formatDocNumber(issued), "01/QĐ-ABC");
    assert.equal(formatDocNumber({ ...issued, direction: "internal" }), "01/QĐ-ABC");
  });

  it("shows Draft for drafts, incoming or outgoing", () => {
    assert.equal(formatDocNumber(row({ status: "draft", arrival_number: null })), "Draft");
    assert.equal(
      formatDocNumber(row({ direction: "outgoing", status: "draft", arrival_number: null, notation: null })),
      "Draft"
    );
  });

  it("shows a dash for an unnumbered document in approval", () => {
    assert.equal(
      formatDocNumber(row({ direction: "outgoing", status: "in_review", arrival_number: null, notation: null })),
      "—"
    );
  });
});

describe("counterpart", () => {
  it("is the issuing organization for incoming", () => {
    assert.equal(counterpart(row()), "Công ty XYZ");
    assert.equal(counterpart(row({ issuing_org_name: null })), "—");
  });

  it("is the recipients for outgoing, else a dash", () => {
    assert.equal(counterpart(row({ direction: "outgoing", recipients_summary: "Sở A, Sở B +2" })), "Sở A, Sở B +2");
    assert.equal(counterpart(row({ direction: "outgoing", recipients_summary: null })), "—");
  });

  it("is the recipients for internal, else Internal", () => {
    assert.equal(counterpart(row({ direction: "internal", recipients_summary: "Phòng KT" })), "Phòng KT");
    assert.equal(counterpart(row({ direction: "internal", recipients_summary: "" })), "Internal");
  });
});

describe("formatDate", () => {
  it("writes yyyy-mm-dd as dd/MM/yyyy", () => {
    assert.equal(formatDate("2026-01-09"), "09/01/2026");
  });

  it("gives an empty string for no date", () => {
    assert.equal(formatDate(null), "");
    assert.equal(formatDate(undefined), "");
    assert.equal(formatDate(""), "");
  });

  it("formats a timestamp as a local date", () => {
    const at = new Date(2026, 9, 30, 12, 0, 0); // local noon, no zone edge
    assert.equal(formatDate(at.toISOString()), "30/10/2026");
  });

  it("returns unreadable input unchanged", () => {
    assert.equal(formatDate("not a date"), "not a date");
  });
});

describe("rowTone", () => {
  // 2026-10-30 is a Friday
  const today = "2026-10-30";

  it("is danger when the deadline has passed", () => {
    assert.equal(rowTone(row({ due_date: "2026-10-29" }), today), "danger");
  });

  it("is warning when due today or within two working days", () => {
    assert.equal(rowTone(row({ due_date: today }), today), "warning");
    // Fri → Tue is two working days
    assert.equal(rowTone(row({ due_date: "2026-11-03" }), today), "warning");
  });

  it("is null when the deadline is further away or missing", () => {
    assert.equal(rowTone(row({ due_date: "2026-11-04" }), today), null);
    assert.equal(rowTone(row({ due_date: null }), today), null);
  });

  it("uses the caller's own deadline before the document's", () => {
    assert.equal(rowTone(row({ due_date: "2026-12-31", my_due_date: "2026-10-01" }), today), "danger");
    assert.equal(rowTone(row({ due_date: "2026-10-01", my_due_date: "2026-12-31" }), today), null);
  });

  it("counts holidays as non-working days", () => {
    const holidays = new Set(["2026-11-02", "2026-11-03"]);
    assert.equal(rowTone(row({ due_date: "2026-11-04" }), today, holidays), "warning");
  });

  it("is null once the document is finished", () => {
    assert.equal(rowTone(row({ status: "completed", due_date: "2026-10-01" }), today), null);
    assert.equal(rowTone(row({ direction: "outgoing", status: "issued", due_date: "2026-10-01" }), today), null);
  });

  it("ignores a malformed deadline", () => {
    assert.equal(rowTone(row({ due_date: "2026-13-45" }), today), null);
  });
});

describe("urgencyTone", () => {
  it("maps urgencies to the stripe colour", () => {
    assert.equal(urgencyTone("hoa_toc"), "danger");
    assert.equal(urgencyTone("thuong_khan"), "warning");
    assert.equal(urgencyTone("khan"), "warning");
    assert.equal(urgencyTone("normal"), null);
    assert.equal(urgencyTone(null), null);
  });
});

describe("pagination", () => {
  it("describes the visible range", () => {
    assert.equal(pageRangeText(1, 50, 120), "Showing 1–50 of 120");
    assert.equal(pageRangeText(3, 50, 120), "Showing 101–120 of 120");
    assert.equal(pageRangeText(1, 50, 7), "Showing 1–7 of 7");
  });

  it("clamps a page past the end and handles no results", () => {
    assert.equal(pageRangeText(9, 50, 120), "Showing 101–120 of 120");
    assert.equal(pageRangeText(0, 50, 120), "Showing 1–50 of 120");
    assert.equal(pageRangeText(1, 50, 0), "No results");
  });

  it("counts pages", () => {
    assert.equal(pageCount(0, 50), 1);
    assert.equal(pageCount(50, 50), 1);
    assert.equal(pageCount(51, 50), 2);
    assert.equal(pageCount(2000, 50), 40);
  });
});

describe("viewCount", () => {
  const dashboard = { ...EMPTY_DASHBOARD, needs_me: 3, overdue: 1, to_issue: 2, urgent: 1 };

  it("returns the dashboard count of the views that have one", () => {
    assert.equal(viewCount(dashboard, "needs_me"), 3);
    assert.equal(viewCount(dashboard, "overdue"), 1);
    assert.equal(viewCount(dashboard, "to_issue"), 2);
    assert.equal(viewCount(dashboard, "for_info"), 0);
  });

  it("is null for views without a count and before the dashboard loads", () => {
    assert.equal(viewCount(dashboard, "all"), null);
    assert.equal(viewCount(dashboard, "following"), null);
    assert.equal(viewCount(null, "needs_me"), null);
  });
});

describe("emptyMessage", () => {
  it("has a message for every view", () => {
    for (const view of DOCUMENT_VIEW_KEYS) assert.ok(emptyMessage(view).length > 0, view);
  });

  it("uses the spec wording", () => {
    assert.equal(emptyMessage("needs_me"), "Nothing needs you right now.");
    assert.equal(emptyMessage("overdue"), "No overdue work.");
  });

  it("points at the filters when they are set", () => {
    assert.equal(emptyMessage("needs_me", true), "No documents match these filters.");
  });
});

describe("inboxSearch", () => {
  it("is empty for the default view without filters", () => {
    assert.equal(inboxSearch({}), "");
    assert.equal(inboxSearch({ view: "needs_me" }), "");
  });

  it("keeps other views and filters in a stable order", () => {
    assert.equal(inboxSearch({ view: "overdue" }), "?view=overdue");
    assert.equal(
      inboxSearch({ urgency: "khan", q: "hợp đồng", view: "all", direction: "incoming" }),
      "?view=all&q=h%E1%BB%A3p+%C4%91%E1%BB%93ng&direction=incoming&urgency=khan"
    );
  });

  it("drops invalid values", () => {
    assert.equal(inboxSearch({ view: "needs_me", year: 12, date_from: "2026-02-30" }), "");
  });
});

describe("csvFileName", () => {
  it("names the export after the day", () => {
    assert.equal(csvFileName("2026-10-30"), "documents-20261030.csv");
    assert.equal(csvFileName("2026-10-30T23:59:00Z"), "documents-20261030.csv");
    assert.equal(csvFileName("bad"), "documents.csv");
  });
});
