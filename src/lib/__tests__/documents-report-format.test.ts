import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatDays,
  formatDuration,
  groupReportRows,
  incomingReportCsv,
  monthLabel,
  monthRange,
  onTimeRate,
  outgoingReportCsv,
  pivotOutgoing,
} from "../documents/report-format.ts";
import type { IncomingReportRow, OutgoingReportRow } from "../documents/filters.ts";

const DEPT_A = "0a1b2c3d-0000-4000-8000-00000000000a";
const DEPT_B = "0a1b2c3d-0000-4000-8000-00000000000b";
const USER_1 = "0a1b2c3d-0000-4000-8000-000000000001";
const USER_2 = "0a1b2c3d-0000-4000-8000-000000000002";
const USER_3 = "0a1b2c3d-0000-4000-8000-000000000003";

function row(overrides: Partial<IncomingReportRow> = {}): IncomingReportRow {
  return {
    department_id: DEPT_A,
    department_name: "Phòng Hành chính",
    assignee_user_id: USER_1,
    assignee_name: "An",
    received: 0,
    done_on_time: 0,
    done_late: 0,
    open_on_time: 0,
    open_overdue: 0,
    avg_days: null,
    ...overrides,
  };
}

const total = (overrides: Partial<IncomingReportRow> = {}) =>
  row({ department_id: null, department_name: "Total", assignee_user_id: null, assignee_name: null, ...overrides });

describe("formatDuration", () => {
  it("prints days and hours", () => {
    assert.equal(formatDuration(51), "2 d 3 h");
    assert.equal(formatDuration(24), "1 d");
    assert.equal(formatDuration(48), "2 d");
    assert.equal(formatDuration(25), "1 d 1 h");
  });

  it("prints hours under a day", () => {
    assert.equal(formatDuration(5), "5 h");
    assert.equal(formatDuration(23.4), "23 h");
    assert.equal(formatDuration(23.6), "1 d");
  });

  it("handles zero and tiny values", () => {
    assert.equal(formatDuration(0), "0 h");
    assert.equal(formatDuration(0.2), "< 1 h");
  });

  it("gives a dash for missing or invalid values", () => {
    assert.equal(formatDuration(null), "—");
    assert.equal(formatDuration(undefined), "—");
    assert.equal(formatDuration(Number.NaN), "—");
    assert.equal(formatDuration(-3), "—");
    assert.equal(formatDuration(Number.POSITIVE_INFINITY), "—");
  });
});

describe("onTimeRate", () => {
  it("is done on time over every known outcome, 0 decimals", () => {
    assert.equal(onTimeRate({ done_on_time: 5, done_late: 1, open_overdue: 0 }), "83%");
    assert.equal(onTimeRate({ done_on_time: 1, done_late: 1, open_overdue: 1 }), "33%");
    assert.equal(onTimeRate({ done_on_time: 2, done_late: 0, open_overdue: 0 }), "100%");
    assert.equal(onTimeRate({ done_on_time: 0, done_late: 3, open_overdue: 0 }), "0%");
  });

  it("ignores open assignments that are not due yet", () => {
    assert.equal(onTimeRate(row({ done_on_time: 1, open_on_time: 9 })), "100%");
  });

  it("gives a dash when nothing is known", () => {
    assert.equal(onTimeRate({ done_on_time: 0, done_late: 0, open_overdue: 0 }), "—");
    assert.equal(onTimeRate(row({ open_on_time: 4 })), "—");
  });
});

describe("monthLabel", () => {
  it("turns YYYY-MM into MM/YYYY", () => {
    assert.equal(monthLabel("2026-10"), "10/2026");
    assert.equal(monthLabel("2026-01"), "01/2026");
  });

  it("leaves anything else alone", () => {
    assert.equal(monthLabel("October"), "October");
    assert.equal(monthLabel("2026-10-01"), "2026-10-01");
    assert.equal(monthLabel(""), "");
  });
});

describe("formatDays", () => {
  it("keeps one decimal", () => {
    assert.equal(formatDays(2), "2.0");
    assert.equal(formatDays(2.46), "2.5");
    assert.equal(formatDays(null), "—");
  });
});

describe("monthRange", () => {
  it("returns the first and last day of the month", () => {
    assert.deepEqual(monthRange("2026-10-30"), { from: "2026-10-01", to: "2026-10-31" });
    assert.deepEqual(monthRange("2026-02-10"), { from: "2026-02-01", to: "2026-02-28" });
    assert.deepEqual(monthRange("2028-02-01"), { from: "2028-02-01", to: "2028-02-29" });
    assert.deepEqual(monthRange("2026-12-31"), { from: "2026-12-01", to: "2026-12-31" });
  });

  it("rejects malformed days", () => {
    assert.equal(monthRange("2026-13-01"), null);
    assert.equal(monthRange("30/10/2026"), null);
    assert.equal(monthRange(""), null);
  });
});

describe("groupReportRows", () => {
  const rows: IncomingReportRow[] = [
    row({ assignee_user_id: USER_1, assignee_name: "An", received: 3, done_on_time: 2, done_late: 1, avg_days: 2 }),
    row({ assignee_user_id: USER_2, assignee_name: "Bình", received: 2, done_on_time: 1, open_overdue: 1, avg_days: 5 }),
    row({
      department_id: DEPT_B,
      department_name: "Phòng Kế toán",
      assignee_user_id: null,
      assignee_name: null,
      received: 1,
      open_on_time: 1,
    }),
    row({
      department_id: null,
      department_name: "No department",
      assignee_user_id: USER_3,
      assignee_name: "Chi",
      received: 1,
      done_on_time: 1,
      avg_days: 1,
    }),
    total({ received: 7, done_on_time: 4, done_late: 1, open_on_time: 1, open_overdue: 1, avg_days: 2.4 }),
  ];

  it("nests people under departments in the server's order, total last", () => {
    const groups = groupReportRows(rows);
    assert.deepEqual(
      groups.map((g) => [g.kind, g.label, g.people.map((p) => p.label)]),
      [
        ["department", "Phòng Hành chính", ["An", "Bình"]],
        ["department", "Phòng Kế toán", ["Whole department"]],
        ["department", "No department", ["Chi"]],
        ["total", "Total", []],
      ]
    );
  });

  it("sums a department from its people with a done-weighted average", () => {
    const [admin] = groupReportRows(rows);
    assert.equal(admin.received, 5);
    assert.equal(admin.done_on_time, 3);
    assert.equal(admin.done_late, 1);
    assert.equal(admin.open_on_time, 0);
    assert.equal(admin.open_overdue, 1);
    // (2 days × 3 done + 5 days × 1 done) / 4 done = 2.75 → 2.8
    assert.equal(admin.avg_days, 2.8);
    assert.equal(admin.department_id, DEPT_A);
  });

  it("keeps the server's total row as is", () => {
    const last = groupReportRows(rows).at(-1)!;
    assert.equal(last.kind, "total");
    assert.equal(last.received, 7);
    assert.equal(last.avg_days, 2.4);
  });

  it("computes the total when the server sent none", () => {
    const last = groupReportRows(rows.slice(0, 2)).at(-1)!;
    assert.equal(last.kind, "total");
    assert.equal(last.received, 5);
    assert.equal(last.open_overdue, 1);
  });

  it("gives just a zero total for no rows", () => {
    const groups = groupReportRows([]);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].kind, "total");
    assert.equal(groups[0].received, 0);
    assert.equal(groups[0].avg_days, null);
  });

  it("gives unique keys and names unnamed people", () => {
    const groups = groupReportRows([row({ assignee_name: "  " }), total()]);
    assert.equal(groups[0].people[0].label, "Unknown person");
    const keys = groupReportRows(rows).flatMap((g) => [g.key, ...g.people.map((p) => p.key)]);
    assert.equal(new Set(keys).size, keys.length);
  });
});

describe("pivotOutgoing", () => {
  const rows: OutgoingReportRow[] = [
    { month: "2026-10", type_name: "Quyết định", issued: 2, avg_approval_hours: 10 },
    { month: "2026-09", type_name: "Công văn", issued: 3, avg_approval_hours: 30 },
    { month: "2026-10", type_name: "Công văn", issued: 1, avg_approval_hours: null },
  ];

  it("lays months out oldest first with types as columns", () => {
    const table = pivotOutgoing(rows);
    assert.deepEqual(table.types, ["Công văn", "Quyết định"]);
    assert.deepEqual(table.months.map((m) => m.label), ["09/2026", "10/2026"]);
    assert.equal(table.months[1].cells["Quyết định"].issued, 2);
    assert.equal(table.months[0].cells["Quyết định"], undefined);
  });

  it("totals months, types and everything", () => {
    const table = pivotOutgoing(rows);
    assert.equal(table.months[1].issued, 3);
    // only the Quyết định cell has an average
    assert.equal(table.months[1].avg_approval_hours, 10);
    assert.equal(table.typeTotals["Công văn"].issued, 4);
    assert.equal(table.typeTotals["Công văn"].avg_approval_hours, 30);
    assert.equal(table.total.issued, 6);
    // (30 × 3 + 10 × 2) / 5 = 22
    assert.equal(table.total.avg_approval_hours, 22);
  });

  it("is empty for no rows", () => {
    const table = pivotOutgoing([]);
    assert.deepEqual(table.types, []);
    assert.deepEqual(table.months, []);
    assert.deepEqual(table.total, { issued: 0, avg_approval_hours: null });
  });
});

describe("report CSV", () => {
  it("writes incoming groups with a BOM, CRLF and the total last", () => {
    const text = incomingReportCsv(
      groupReportRows([
        row({ received: 2, done_on_time: 1, done_late: 1, avg_days: 3 }),
        total({ received: 2, done_on_time: 1, done_late: 1, avg_days: 3 }),
      ])
    );
    assert.ok(text.startsWith("﻿Department,Person,Received,"));
    const lines = text.slice(1).split("\r\n");
    assert.equal(lines.at(-1), "");
    assert.deepEqual(lines.slice(1, -1), [
      "Phòng Hành chính,,2,1,1,0,0,3.0,50%",
      "Phòng Hành chính,An,2,1,1,0,0,3.0,50%",
      "Total,,2,1,1,0,0,3.0,50%",
    ]);
  });

  it("guards formula-looking names", () => {
    const text = incomingReportCsv(groupReportRows([row({ assignee_name: "=HYPERLINK(1)" })]));
    assert.ok(text.includes(",'=HYPERLINK(1),"));
  });

  it("writes outgoing rows per month and type, then the total", () => {
    const text = outgoingReportCsv([
      { month: "2026-10", type_name: "Quyết định", issued: 2, avg_approval_hours: 51 },
      { month: "2026-10", type_name: "Tờ trình, kế hoạch", issued: 1, avg_approval_hours: null },
    ]);
    const lines = text.slice(1).split("\r\n");
    assert.deepEqual(lines.slice(0, 4), [
      "Month,Document type,Issued,Avg approval time,Avg approval hours",
      "10/2026,Quyết định,2,2 d 3 h,51",
      '10/2026,"Tờ trình, kế hoạch",1,,',
      "Total,,3,2 d 3 h,51",
    ]);
  });
});
