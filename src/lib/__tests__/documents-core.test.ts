import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DOC_EVENT_ACTIONS,
  FINAL_STATUSES,
  INCOMING_STATUSES,
  OUTGOING_STATUSES,
  URGENCIES,
  isDocEventAction,
  isFinalStatus,
  statusesFor,
} from "../documents/types.ts";
import {
  ASSIGNMENT_ROLE_LABELS,
  DIRECTION_LABELS,
  STATUS_LABELS,
  URGENCY_LABELS,
  statusTone,
  urgencyRank,
} from "../documents/labels.ts";
import { formatNumberLabel, padNumber, renderNotation } from "../documents/numbering.ts";
import {
  addWorkingDays,
  defaultDueDate,
  defaultDueDays,
  dueState,
  formatDay,
  holidaySet,
  isWorkingDay,
  todayIn,
  workingDaysBetween,
} from "../documents/deadlines.ts";

// Shared with SQL doc_render_notation (supabase/tests/9936_documents_core.sql):
// both sides must keep exactly these rows.
const NOTATION_CASES: [string, number, string, string, string, number, string][] = [
  ["{n}/{type}-{org}", 1, "QĐ", "ABC", "HCNS", 2026, "01/QĐ-ABC"],
  ["{n}/{org}-{dept}", 5, "", "ABC", "HCNS", 2026, "05/ABC-HCNS"],
  ["{n}/{org}-{dept}", 5, "", "ABC", "", 2026, "05/ABC"],
  ["{n}/{type}-{org}", 123, "QĐ", "ABC", "", 2026, "123/QĐ-ABC"],
  ["{n}/{type}-{org}-{dept}", 7, "TB", "ABC", "", 2026, "07/TB-ABC"],
  ["{n}/{yyyy}/{type}", 3, "HĐ", "ABC", "", 2026, "03/2026/HĐ"],
  ["{n}/{type}-{org}", 2, "", "ABC", "", 2026, "02/ABC"],
];

describe("renderNotation", () => {
  for (const [template, n, type, org, dept, year, expected] of NOTATION_CASES) {
    it(`${template} n=${n} type='${type}' dept='${dept}' → ${expected}`, () => {
      assert.equal(renderNotation(template, { n, type, org, dept, year }), expected);
    });
  }

  it("pads to two digits only", () => {
    assert.equal(padNumber(1), "01");
    assert.equal(padNumber(10), "10");
    assert.equal(padNumber(1234), "1234");
  });

  it("treats null tokens as empty", () => {
    assert.equal(renderNotation("{n}/{type}-{org}", { n: 9, type: null, org: "ABC", year: 2026 }), "09/ABC");
  });
});

describe("formatNumberLabel", () => {
  it("shows the notation of an outgoing/internal document", () => {
    assert.equal(formatNumberLabel({ direction: "outgoing", notation: "15/QĐ-ABC", number: 15 }), "Số: 15/QĐ-ABC");
    assert.equal(formatNumberLabel({ direction: "internal", notation: null, number: 4 }), "Số: 04");
  });

  it("shows the arrival number of an incoming document", () => {
    assert.equal(formatNumberLabel({ direction: "incoming", notation: "88/UBND", arrival_number: 12 }), "Đến số 12");
  });

  it("says Draft before numbering", () => {
    assert.equal(formatNumberLabel({ direction: "outgoing", notation: null, number: null }), "Draft");
    assert.equal(formatNumberLabel({ direction: "incoming", arrival_number: null }), "Draft");
  });
});

describe("working days", () => {
  it("skips the weekend: Friday 2026-10-30 + 1 = Monday 2026-11-02", () => {
    assert.equal(addWorkingDays("2026-10-30", 1, new Set()), "2026-11-02");
    assert.equal(addWorkingDays("2026-10-30", 5, new Set()), "2026-11-06");
  });

  it("skips holidays", () => {
    assert.equal(addWorkingDays("2026-10-30", 1, new Set(["2026-11-02"])), "2026-11-03");
    // Tết-like run of holidays across a weekend
    const tet = holidaySet([{ day: "2027-02-08" }, { day: "2027-02-09" }, { day: "2027-02-10" }]);
    assert.equal(addWorkingDays("2027-02-05", 1, tet), "2027-02-11");
  });

  it("0 days stays on a working day, else moves to the next one", () => {
    assert.equal(addWorkingDays("2026-10-30", 0, new Set()), "2026-10-30");
    assert.equal(addWorkingDays("2026-10-31", 0, new Set()), "2026-11-02");
    assert.equal(addWorkingDays("2026-11-02", 0, new Set(["2026-11-02"])), "2026-11-03");
  });

  it("counts from a weekend or holiday start like workingDaysBetween", () => {
    // Saturday + 1 working day = Monday, not Tuesday
    assert.equal(addWorkingDays("2026-10-31", 1, new Set()), "2026-11-02");
    assert.equal(addWorkingDays("2026-11-01", 2, new Set()), "2026-11-03");
    assert.equal(addWorkingDays("2026-11-02", 1, new Set(["2026-11-02"])), "2026-11-03");
    for (const from of ["2026-10-30", "2026-10-31", "2026-11-01"]) {
      for (const days of [1, 2, 5, 9]) {
        assert.equal(workingDaysBetween(from, addWorkingDays(from, days)), days, `${from} + ${days}`);
      }
    }
  });

  it("crosses month and year ends", () => {
    assert.equal(addWorkingDays("2026-12-31", 1, new Set(["2027-01-01"])), "2027-01-04");
  });

  it("knows weekdays and counts working days between dates", () => {
    assert.equal(isWorkingDay("2026-10-31"), false);
    assert.equal(isWorkingDay("2026-11-02"), true);
    assert.equal(workingDaysBetween("2026-10-30", "2026-11-04"), 3);
    assert.equal(workingDaysBetween("2026-11-04", "2026-10-30"), 0);
  });

  it("rejects malformed dates", () => {
    assert.throws(() => addWorkingDays("30/10/2026", 1));
    assert.throws(() => addWorkingDays("2026-02-30", 1));
  });

  it("default deadlines by urgency", () => {
    assert.deepEqual(
      URGENCIES.map((u) => defaultDueDays(u)),
      [7, 2, 1, 0]
    );
    assert.equal(defaultDueDate("2026-10-30", "khan"), "2026-11-03");
    assert.equal(defaultDueDate("2026-10-30", "hoa_toc"), "2026-10-30");
  });
});

describe("dueState", () => {
  const today = "2026-10-30"; // Friday

  it("is null without a deadline", () => {
    assert.equal(dueState(null, today), null);
    assert.equal(dueState("", today), null);
  });

  it("overdue, due today, due soon, ok", () => {
    assert.equal(dueState("2026-10-29", today), "overdue");
    assert.equal(dueState("2026-10-30", today), "due_today");
    assert.equal(dueState("2026-11-02", today), "due_soon"); // 1 working day
    assert.equal(dueState("2026-11-03", today), "due_soon"); // 2 working days
    assert.equal(dueState("2026-11-04", today), "ok"); // 3 working days
    assert.equal(dueState("2030-01-01", today), "ok");
  });

  it("holidays push a deadline into due soon", () => {
    assert.equal(dueState("2026-11-04", today, new Set(["2026-11-02"])), "due_soon");
  });

  it("ignores a time part", () => {
    assert.equal(dueState("2026-10-30T09:00:00+07:00", today), "due_today");
  });
});

describe("todayIn", () => {
  it("uses the company time zone, not UTC", () => {
    const now = new Date("2026-12-31T17:30:00Z");
    assert.equal(todayIn("Asia/Ho_Chi_Minh", now), "2027-01-01");
    assert.equal(todayIn("UTC", now), "2026-12-31");
  });

  it("falls back to Asia/Ho_Chi_Minh for an unknown zone", () => {
    assert.equal(todayIn("Not/AZone", new Date("2026-12-31T17:30:00Z")), "2027-01-01");
    assert.equal(todayIn(null, new Date("2026-12-31T17:30:00Z")), "2027-01-01");
  });

  it("formats days the Vietnamese way", () => {
    assert.equal(formatDay("2026-11-02"), "02/11/2026");
    assert.equal(formatDay(null), "");
  });
});

describe("types and labels", () => {
  it("DOC_EVENT_ACTIONS has no duplicates and holds the canonical 32 names", () => {
    assert.equal(new Set(DOC_EVENT_ACTIONS).size, DOC_EVENT_ACTIONS.length);
    assert.equal(DOC_EVENT_ACTIONS.length, 32);
    assert.equal(isDocEventAction("issued"), true);
    assert.equal(isDocEventAction("deleted"), false);
  });

  it("has a label and a tone for every status", () => {
    for (const s of [...INCOMING_STATUSES, ...OUTGOING_STATUSES]) {
      assert.ok(STATUS_LABELS[s], s);
      assert.ok(["neutral", "info", "warning", "success", "danger"].includes(statusTone(s)), s);
    }
    assert.equal(statusTone("issued"), "success");
    assert.equal(statusTone("recalled"), "danger");
    assert.equal(statusTone("unknown"), "neutral");
  });

  it("final statuses are valid statuses", () => {
    const all = new Set<string>([...INCOMING_STATUSES, ...OUTGOING_STATUSES]);
    for (const s of FINAL_STATUSES) assert.ok(all.has(s), s);
    assert.equal(isFinalStatus("completed"), true);
    assert.equal(isFinalStatus("in_progress"), false);
    assert.equal(isFinalStatus(null), false);
    assert.equal(statusesFor("incoming").includes("registered"), true);
    assert.equal(statusesFor("internal").includes("registered"), false);
  });

  it("labels carry the Vietnamese terms", () => {
    assert.equal(DIRECTION_LABELS.incoming, "Incoming (Văn bản đến)");
    assert.equal(URGENCY_LABELS.hoa_toc, "Immediate (Hỏa tốc)");
    assert.equal(ASSIGNMENT_ROLE_LABELS.lead, "Lead (Chủ trì)");
  });

  it("ranks urgency", () => {
    assert.deepEqual(URGENCIES.map(urgencyRank), [0, 1, 2, 3]);
    assert.equal(urgencyRank(null), 0);
    assert.equal(urgencyRank("unknown"), 0);
  });
});
