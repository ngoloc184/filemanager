import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DOCUMENT_VIEWS,
  DOCUMENT_VIEW_KEYS,
  csvField,
  csvForResults,
  filtersFromSearchParams,
  filtersToSearchParams,
  hasActiveFilters,
  isIsoDay,
  normalizeFilters,
  visibleViews,
  type DocumentFilters,
  type DocumentSearchRow,
} from "../documents/filters.ts";

const TYPE_ID = "0a1b2c3d-0000-4000-8000-000000000001";
const REGISTER_ID = "0a1b2c3d-0000-4000-8000-000000000002";

const roundTrip = (f: DocumentFilters) => filtersFromSearchParams(filtersToSearchParams(f));

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
    urgency: "khan",
    confidentiality: "normal",
    due_date: "2026-10-12",
    my_due_date: null,
    updated_at: "2026-10-05T03:00:00Z",
    created_at: "2026-10-05T03:00:00Z",
    recipients_summary: null,
    total_count: 1,
    ...overrides,
  };
}

describe("document views", () => {
  it("lists every view once, needs_me first and all last", () => {
    assert.deepEqual(
      DOCUMENT_VIEWS.map((v) => v.key).sort(),
      [...DOCUMENT_VIEW_KEYS].sort()
    );
    assert.equal(DOCUMENT_VIEWS[0].key, "needs_me");
    assert.equal(DOCUMENT_VIEWS[0].label, "Needs me (Cần xử lý)");
    assert.equal(DOCUMENT_VIEWS.at(-1)?.key, "all");
  });

  it("hides the clerk views from staff", () => {
    const staff = visibleViews(["staff"]).map((v) => v.key);
    assert.ok(staff.includes("needs_me"));
    assert.ok(staff.includes("for_info"));
    assert.ok(!staff.includes("to_register"));
    assert.ok(!staff.includes("to_issue"));
    assert.equal(staff.length, DOCUMENT_VIEWS.length - 2);
  });

  it("shows the clerk views to a clerk, in display order", () => {
    const clerk = visibleViews(["leader", "clerk"]).map((v) => v.key);
    assert.deepEqual(clerk, DOCUMENT_VIEWS.map((v) => v.key));
  });

  it("treats no roles as staff", () => {
    assert.deepEqual(visibleViews(null), visibleViews(["staff"]));
    assert.deepEqual(visibleViews([]), visibleViews(undefined));
  });
});

describe("filters in the URL", () => {
  it("round-trips a full set of filters", () => {
    const f: DocumentFilters = {
      view: "overdue",
      q: "hợp đồng",
      direction: "incoming",
      status: ["registered", "in_progress"],
      doc_type_id: TYPE_ID,
      urgency: "hoa_toc",
      confidentiality: "internal",
      register_id: REGISTER_ID,
      year: 2026,
      date_from: "2026-01-01",
      date_to: "2026-12-31",
    };
    assert.deepEqual(roundTrip(f), f);
  });

  it("writes a stable query and leaves out empty values", () => {
    const sp = filtersToSearchParams({ q: "  ", status: [], view: "all", direction: "outgoing" });
    assert.equal(sp.toString(), "view=all&direction=outgoing");
    assert.deepEqual(roundTrip({}), {});
  });

  it("drops invalid enums, ids, years and dates", () => {
    const f = filtersFromSearchParams(
      new URLSearchParams(
        "view=everything&direction=sideways&urgency=asap&confidentiality=top&register_id=1&year=20x6&date_from=2026-02-30&date_to=31/12/2026&status=bogus"
      )
    );
    assert.deepEqual(f, {});
  });

  it("keeps only statuses the chosen direction can have", () => {
    const f = filtersFromSearchParams(new URLSearchParams("direction=outgoing&status=signed,registered,signed"));
    assert.deepEqual(f, { direction: "outgoing", status: ["signed"] });
    // repeated params work too
    const g = filtersFromSearchParams(new URLSearchParams("status=issued&status=draft"));
    assert.deepEqual(g.status, ["draft", "issued"]);
  });

  it("trims and collapses the search text and caps its length", () => {
    assert.equal(filtersFromSearchParams(new URLSearchParams("q=%20 hop   dong %20")).q, "hop dong");
    assert.equal(filtersFromSearchParams(new URLSearchParams(`q=${"a".repeat(500)}`)).q?.length, 200);
  });

  it("normalizes ids to lower case and years from numbers", () => {
    const f = normalizeFilters({ doc_type_id: TYPE_ID.toUpperCase(), year: 2025 });
    assert.deepEqual(f, { doc_type_id: TYPE_ID, year: 2025 });
  });

  it("knows when filters other than the view are set", () => {
    assert.equal(hasActiveFilters({ view: "needs_me" }), false);
    assert.equal(hasActiveFilters({ view: "needs_me", q: "x" }), true);
    assert.equal(hasActiveFilters({ q: " " }), false);
  });

  it("validates calendar dates", () => {
    assert.equal(isIsoDay("2028-02-29"), true);
    assert.equal(isIsoDay("2026-02-29"), false);
    assert.equal(isIsoDay("2026-1-01"), false);
  });
});

describe("csvForResults", () => {
  it("starts with a BOM, uses CRLF and has a header", () => {
    const csv = csvForResults([]);
    assert.ok(csv.startsWith("﻿"));
    assert.ok(csv.endsWith("\r\n"));
    const header = csv.slice(1).split("\r\n")[0];
    assert.ok(header.startsWith("\"Number (Số, ký hiệu)\","));
    assert.ok(header.includes("Subject (Trích yếu)"));
  });

  it("writes one line per row with Vietnamese intact and dd/MM/yyyy dates", () => {
    const csv = csvForResults([row()]);
    const lines = csv.slice(1).split("\r\n");
    assert.equal(lines.length, 3); // header, row, trailing empty
    const line = lines[1];
    assert.ok(line.startsWith("Đến 7 · 12/CV-XYZ,Incoming (Văn bản đến),Công văn,Hợp đồng thuê văn phòng,Công ty XYZ,"));
    assert.ok(line.includes(",05/10/2026,01/10/2026,"));
    assert.ok(line.includes("Urgent (Khẩn)"));
    assert.ok(line.includes(",12/10/2026,"), "due date falls back to the document's");
  });

  it("prefers my deadline and shows recipients for outgoing documents", () => {
    const csv = csvForResults([
      row({
        direction: "outgoing",
        notation: "01/QĐ-ABC",
        arrival_number: null,
        my_due_date: "2026-10-09",
        recipients_summary: "Phòng KT, Phòng HC",
        status: "issued",
      }),
    ]);
    const line = csv.slice(1).split("\r\n")[1];
    assert.ok(line.startsWith("01/QĐ-ABC,Outgoing (Văn bản đi),"));
    assert.ok(line.includes("\"Phòng KT, Phòng HC\""));
    assert.ok(line.includes(",09/10/2026,"));
  });

  it("quotes commas, quotes and newlines (RFC 4180)", () => {
    assert.equal(csvField('Say "hi", then\nleave'), '"Say ""hi"", then\nleave"');
    assert.equal(csvField("plain"), "plain");
    assert.equal(csvField(null), "");
    assert.equal(csvField(42), "42");
    const csv = csvForResults([row({ subject: 'Về việc "A", B\r\nC' })]);
    assert.ok(csv.includes('"Về việc ""A"", B\r\nC"'));
  });

  it("defuses spreadsheet formulas", () => {
    assert.equal(csvField("=HYPERLINK(\"x\")"), "\"'=HYPERLINK(\"\"x\"\")\"");
    assert.equal(csvField("+1"), "'+1");
    assert.equal(csvField("-1"), "'-1");
    assert.equal(csvField("@cmd"), "'@cmd");
    assert.equal(csvField(-1), "-1");
  });
});
