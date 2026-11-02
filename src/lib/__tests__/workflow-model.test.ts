import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_HOURS,
  addWork,
  autoLayout,
  blankDoc,
  cloneDoc,
  connectSteps,
  dayMark,
  defaultStart,
  formatStamp,
  isOverdue,
  mergeDocs,
  minutesPerDay,
  normalizeStart,
  parseDoc,
  parseLog,
  parseStamp,
  planRange,
  removeSteps,
  schedule,
  topoOrder,
  workBetween,
  wouldCreateCycle,
  type StepLog,
  type WorkflowDoc,
  type WorkflowEdge,
  type WorkflowStep,
} from "../workflow/model.ts";
import { exampleDoc } from "../workflow/template.ts";

// 2026-11-02 is a Monday
const H = DEFAULT_HOURS;
const t = (s: string) => parseStamp(s);
const f = (n: number) => formatStamp(n);

const step = (id: string, amount: number, unit: "h" | "d" = "d", extra: Partial<WorkflowStep> = {}): WorkflowStep => ({
  id,
  title: id,
  note: "",
  picIds: [],
  duration: { amount, unit },
  status: "todo",
  position: { x: 0, y: 0 },
  ...extra,
});
const edge = (source: string, target: string): WorkflowEdge => ({ id: `e_${source}_${target}`, source, target });
const doc = (steps: WorkflowStep[], edges: WorkflowEdge[], start = "2026-11-02T08:00"): WorkflowDoc => ({ ...blankDoc("2026-11-02"), start, steps, edges });
const extend = (stepId: string, amount: number, unit: "h" | "d", cancelled = false): StepLog => ({
  id: `l_${stepId}_${amount}${unit}`,
  stepId,
  kind: "extend",
  amount,
  unit,
  oldAmount: null,
  oldUnit: null,
  reason: "x",
  requesterName: "A",
  requesterRole: "QC",
  signedIn: false,
  createdAt: "",
  cancelledAt: cancelled ? "2026-11-03T00:00:00Z" : null,
});

describe("clock", () => {
  it("parses and rejects stamps", () => {
    assert.equal(f(t("2026-11-02T08:30")), "2026-11-02T08:30");
    assert.ok(Number.isNaN(t("2026-02-30T08:00")));
    assert.ok(Number.isNaN(t("2026-11-02T25:00")));
    assert.ok(Number.isNaN(t("2026-11-02")));
  });
});

describe("working time", () => {
  it("is 8 hours a day by default", () => {
    assert.equal(minutesPerDay(H), 480);
  });

  it("moves a start into working hours, skipping the break and the weekend", () => {
    assert.equal(f(normalizeStart(t("2026-11-02T06:00"), H)), "2026-11-02T08:00");
    assert.equal(f(normalizeStart(t("2026-11-02T12:30"), H)), "2026-11-02T13:00");
    assert.equal(f(normalizeStart(t("2026-11-02T17:00"), H)), "2026-11-03T08:00");
    assert.equal(f(normalizeStart(t("2026-11-06T17:00"), H)), "2026-11-09T08:00"); // Friday evening → Monday
    assert.equal(f(normalizeStart(t("2026-11-07T10:00"), H)), "2026-11-09T08:00"); // Saturday
  });

  it("adds working hours across the break, nights and weekends", () => {
    assert.equal(f(addWork(t("2026-11-02T08:00"), 60, H)), "2026-11-02T09:00");
    assert.equal(f(addWork(t("2026-11-02T08:00"), 480, H)), "2026-11-02T17:00"); // one day ends that evening
    assert.equal(f(addWork(t("2026-11-02T11:00"), 120, H)), "2026-11-02T14:00");
    assert.equal(f(addWork(t("2026-11-06T16:00"), 120, H)), "2026-11-09T09:00"); // Friday 16:00 + 2 h
    assert.equal(f(addWork(t("2026-11-02T08:00"), 5 * 480, H)), "2026-11-06T17:00");
  });

  it("counts working minutes between two moments", () => {
    assert.equal(workBetween(t("2026-11-02T08:00"), t("2026-11-02T17:00"), H), 480);
    assert.equal(workBetween(t("2026-11-06T16:00"), t("2026-11-09T09:00"), H), 120);
    assert.equal(workBetween(t("2026-11-03T08:00"), t("2026-11-02T08:00"), H), 0);
  });

  it("can count weekends when asked", () => {
    const all = { ...H, skipWeekends: false };
    assert.equal(f(addWork(t("2026-11-06T16:00"), 120, all)), "2026-11-07T09:00");
  });
});

describe("schedule", () => {
  it("chains each step after the one before it", () => {
    const d = doc([step("a", 2), step("b", 4, "h"), step("c", 1)], [edge("a", "b"), edge("b", "c")]);
    const s = schedule(d);
    assert.equal(f(s.get("a")!.start), "2026-11-02T08:00");
    assert.equal(f(s.get("a")!.end), "2026-11-03T17:00");
    assert.equal(f(s.get("b")!.start), "2026-11-04T08:00");
    assert.equal(f(s.get("b")!.end), "2026-11-04T12:00");
    assert.equal(f(s.get("c")!.start), "2026-11-04T13:00");
    assert.equal(f(s.get("c")!.end), "2026-11-05T12:00");
  });

  it("starts a step after its last predecessor when branches join", () => {
    const d = doc([step("a", 1), step("b", 3), step("c", 1)], [edge("a", "c"), edge("b", "c")]);
    assert.equal(f(schedule(d).get("c")!.start), "2026-11-05T08:00");
  });

  it("adds active extensions and pushes the later steps", () => {
    const d = doc([step("a", 1), step("b", 1)], [edge("a", "b")]);
    const s = schedule(d, [extend("a", 2, "d"), extend("a", 4, "h"), extend("a", 9, "d", true)]);
    const a = s.get("a")!;
    assert.equal(f(a.baseEnd), "2026-11-02T17:00");
    assert.equal(f(a.end), "2026-11-05T12:00"); // 1 d + 2 d + 4 h; the cancelled one is ignored
    assert.equal(a.extraMinutes, 2 * 480 + 240);
    assert.equal(f(s.get("b")!.start), "2026-11-05T13:00");
  });

  it("moves with the plan start", () => {
    const d = doc([step("a", 1)], [], "2026-11-07T09:00");
    assert.equal(f(schedule(d).get("a")!.start), "2026-11-09T08:00");
  });

  it("gives T+n marks and the plan range", () => {
    const d = doc([step("a", 2), step("b", 4, "h")], [edge("a", "b")]);
    const s = schedule(d);
    assert.equal(dayMark(d, s.get("a")!.end), 2);
    assert.equal(dayMark(d, s.get("b")!.end), 2.5);
    assert.deepEqual(planRange(s), { start: t("2026-11-02T08:00"), end: t("2026-11-04T12:00") });
    assert.equal(planRange(new Map()), null);
  });

  it("flags overdue steps that are not done", () => {
    const d = doc([step("a", 1)], []);
    const slot = schedule(d).get("a");
    assert.equal(isOverdue(d.steps[0], slot, t("2026-11-03T08:00")), true);
    assert.equal(isOverdue({ ...d.steps[0], status: "done" }, slot, t("2026-11-03T08:00")), false);
    assert.equal(isOverdue(d.steps[0], slot, t("2026-11-02T16:00")), false);
  });
});

describe("graph", () => {
  it("orders steps and detects loops", () => {
    assert.deepEqual(topoOrder([step("c", 1), step("a", 1), step("b", 1)], [edge("a", "b"), edge("b", "c")]), ["a", "b", "c"]);
    assert.equal(wouldCreateCycle([edge("a", "b"), edge("b", "c")], "c", "a"), true);
    assert.equal(wouldCreateCycle([edge("a", "b")], "a", "a"), true);
  });

  it("connects steps but refuses loops and duplicates", () => {
    const edges = [edge("a", "b"), edge("b", "c")];
    assert.deepEqual(connectSteps(edges, "c", "a"), { ok: false, reason: "cycle" });
    assert.deepEqual(connectSteps(edges, "a", "b"), { ok: false, reason: "duplicate" });
    const r = connectSteps(edges, "a", "c");
    assert.ok(r.ok && r.edges.length === 3);
  });

  it("removes steps with their arrows", () => {
    const out = removeSteps(doc([step("a", 1), step("b", 1), step("c", 1)], [edge("a", "b"), edge("b", "c")]), ["b"]);
    assert.deepEqual(out.steps.map((s) => s.id), ["a", "c"]);
    assert.deepEqual(out.edges, []);
  });

  it("snakes a long chain into rows", () => {
    const steps = ["a", "b", "c", "d", "e", "f"].map((id) => step(id, 1));
    const edges = ["a", "b", "c", "d", "e"].map((id, i) => edge(id, ["b", "c", "d", "e", "f"][i]));
    const pos = Object.fromEntries(autoLayout(steps, edges, 4).map((s) => [s.id, s.position]));
    assert.ok(pos.a.x < pos.b.x && pos.c.x < pos.d.x);
    assert.equal(pos.e.x, pos.d.x);
    assert.ok(pos.e.y > pos.d.y && pos.f.x < pos.e.x);
  });
});

describe("mergeDocs", () => {
  const base = doc([step("a", 1), step("b", 1)], [edge("a", "b")]);

  it("keeps my field changes and someone else's other changes", () => {
    const local = { ...base, steps: [{ ...base.steps[0], title: "mine" }, base.steps[1]] };
    const remote = { ...base, steps: [{ ...base.steps[0], duration: { amount: 3, unit: "d" as const } }, { ...base.steps[1], status: "done" as const }] };
    const m = mergeDocs(base, local, remote);
    assert.equal(m.steps[0].title, "mine");
    assert.deepEqual(m.steps[0].duration, { amount: 3, unit: "d" });
    assert.equal(m.steps[1].status, "done");
  });

  it("keeps steps added on either side and deletions from either side", () => {
    const local = { ...removeSteps(base, ["b"]), steps: [base.steps[0], step("mine", 1)] };
    const remote = { ...base, steps: [...base.steps, step("theirs", 2)] };
    const m = mergeDocs(base, local, remote);
    assert.deepEqual(m.steps.map((s) => s.id).sort(), ["a", "mine", "theirs"]);
    assert.deepEqual(m.edges, []); // the arrow to the deleted step is gone
  });

  it("takes the remote start unless I changed it", () => {
    assert.equal(mergeDocs(base, base, { ...base, start: "2026-12-01T08:00" }).start, "2026-12-01T08:00");
    assert.equal(mergeDocs(base, { ...base, start: "2026-11-20T08:00" }, { ...base, start: "2026-12-01T08:00" }).start, "2026-11-20T08:00");
  });
});

describe("parseDoc", () => {
  it("keeps a valid plan intact", () => {
    const d = exampleDoc("2026-11-02");
    assert.deepEqual(parseDoc(JSON.parse(JSON.stringify(d)), "2026-11-02"), d);
  });

  it("drops what does not fit", () => {
    const d = parseDoc(
      {
        start: "soon",
        hours: { dayStart: "17:00", dayEnd: "08:00" },
        roles: [{ id: "r1", name: "QC", color: "neon" }, { id: "bad id!", name: "x" }],
        steps: [
          { id: "a", picIds: ["r1", "ghost"], duration: { amount: -4, unit: "w" }, status: "weird" },
          { id: "b", duration: { amount: 2.6, unit: "h" } },
          { id: "a" },
        ],
        edges: [{ source: "a", target: "b" }, { source: "b", target: "a" }],
      },
      "2026-11-07"
    );
    assert.ok(d);
    assert.equal(d.start, "2026-11-09T08:00"); // the next working morning
    assert.deepEqual(d.hours, DEFAULT_HOURS);
    assert.deepEqual(d.roles, [{ id: "r1", name: "QC", color: "violet" }]);
    assert.deepEqual(d.steps.map((s) => [s.id, s.picIds, s.duration, s.status]), [
      ["a", ["r1"], { amount: 1, unit: "d" }, "todo"],
      ["b", [], { amount: 3, unit: "h" }, "todo"],
    ]);
    assert.deepEqual(d.edges.map((e) => `${e.source}>${e.target}`), ["a>b"]);
  });

  it("rejects non-plans", () => {
    assert.equal(parseDoc(null, "2026-11-02"), null);
    assert.equal(parseDoc([], "2026-11-02"), null);
    assert.equal(parseDoc({ name: "x" }, "2026-11-02"), null);
  });

  it("reads log rows", () => {
    const log = parseLog({ id: "1", step_id: "a", kind: "extend", amount: 2, unit: "d", reason: "r", requester_name: "Minh", requester_role: "QC", signed_in: false, created_at: "x", cancelled_at: null });
    assert.equal(log?.requesterName, "Minh");
    assert.equal(parseLog({ id: "1", step_id: "a", kind: "other", amount: 2, unit: "d" }), null);
  });
});

describe("example and copies", () => {
  it("chains the 12 steps from the first working morning, step 1 ending at T+2", () => {
    const d = exampleDoc("2026-11-07");
    assert.equal(d.start, "2026-11-09T08:00");
    assert.equal(d.steps.length, 12);
    assert.equal(d.edges.length, 11);
    const s = schedule(d);
    assert.equal(dayMark(d, s.get("s_step01")!.end), 2);
    assert.equal(s.get("s_step02")!.start, s.get("s_step01")!.end + 15 * 60); // Tue 17:00 → Wed 08:00
    assert.deepEqual(d.steps[5].picIds, ["r_qcfpt", "r_devfpt", "r_devhd"]);
  });

  it("clones a plan for another feature with fresh statuses", () => {
    const d = exampleDoc("2026-11-02");
    d.steps[0].status = "done";
    const c = cloneDoc(d, { name: "Quy trình gốc" }, defaultStart("2026-12-01"));
    assert.equal(c.start, "2026-12-01T08:00");
    assert.ok(c.steps.every((s) => s.status === "todo"));
    assert.deepEqual(c.clonedFrom, { name: "Quy trình gốc" }); // no id: it would open the source
    assert.equal(d.steps[0].status, "done"); // the source is untouched
  });
});
