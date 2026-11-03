import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { blankDoc, parseStamp, schedule, type WorkflowDoc, type WorkflowStep } from "../workflow/model.ts";
import { autoReminder, buildConfirmEmail, buildReminderEmail, confirmDigests, dueReminders, isWorkingTime, longMoment, recipientsFor, reminderKind, wallNow } from "../workflow/reminders.ts";

// 2026-11-02 is a Monday
const t = (s: string) => parseStamp(s);
const step = (id: string, days: number, extra: Partial<WorkflowStep> = {}): WorkflowStep => ({
  id,
  title: `Bước ${id}`,
  note: "",
  picIds: ["r_qc"],
  duration: { amount: days, unit: "d" },
  status: "todo",
  position: { x: 0, y: 0 },
  confirmed: null,
  ...extra,
});
const plan = (steps: WorkflowStep[], start = "2026-11-02T08:00"): WorkflowDoc => ({
  ...blankDoc("2026-11-02"),
  start,
  roles: [{ id: "r_qc", name: "QC HDBank", color: "emerald" }, { id: "r_dev", name: "DEV FPT", color: "violet" }],
  steps,
  edges: steps.slice(1).map((s, i) => ({ id: `e${i}`, source: steps[i].id, target: s.id })),
});

describe("wallNow", () => {
  it("reads the clock of the plan's time zone", () => {
    assert.equal(wallNow("Asia/Ho_Chi_Minh", new Date("2026-11-02T01:00:00Z")), t("2026-11-02T08:00"));
  });
});

describe("reminderKind", () => {
  // a: Mon–Tue, b: Wed, c: Thu–Fri
  const doc = plan([step("a", 2), step("b", 1), step("c", 2)]);
  const slots = schedule(doc);
  const kind = (id: string, now: string, manual = false) => reminderKind(doc.steps.find((s) => s.id === id)!, slots.get(id), t(now), doc.hours, manual);

  it("warns the day before a step starts", () => {
    assert.equal(kind("b", "2026-11-03T08:00"), "upcoming");
    assert.equal(kind("c", "2026-11-03T08:00"), null);
  });

  it("warns on Friday for a step starting on Monday", () => {
    const d = plan([step("a", 5), step("b", 1)]);
    const s = schedule(d);
    assert.equal(reminderKind(d.steps[1], s.get("b"), t("2026-11-06T08:00"), d.hours), "upcoming");
  });

  it("reminds on the due day and after it until the step is done", () => {
    assert.equal(kind("a", "2026-11-03T08:00"), "due");
    assert.equal(kind("a", "2026-11-04T08:00"), "overdue");
    const done = { ...doc.steps[0], status: "done" as const };
    assert.equal(reminderKind(done, slots.get("a"), t("2026-11-04T08:00"), doc.hours), null);
  });

  it("lists a step starting today", () => {
    assert.equal(kind("a", "2026-11-02T10:00"), "start");
  });

  it("only sends a progress note by hand", () => {
    const d = plan([step("a", 3)]);
    const s = schedule(d);
    assert.equal(reminderKind(d.steps[0], s.get("a"), t("2026-11-03T10:00"), d.hours), null);
    assert.equal(reminderKind(d.steps[0], s.get("a"), t("2026-11-03T10:00"), d.hours, true), "progress");
    assert.equal(kind("c", "2026-11-02T10:00", true), "upcoming");
  });
});

const day = (s: string) => Math.floor(t(`${s}T00:00`) / 1440);

describe("autoReminder", () => {
  it("reminds a step in days on its start day and, when longer than a day, on its due day", () => {
    // a: Mon–Wed (3 d), b: Thu (1 d)
    const doc = plan([step("a", 3), step("b", 1)]);
    const slots = schedule(doc);
    const at = (id: string, now: string) => autoReminder(doc.steps.find((s) => s.id === id)!, slots.get(id), t(now), doc.hours);
    assert.deepEqual(at("a", "2026-11-02T08:00"), { kind: "start", day: day("2026-11-02") });
    assert.equal(at("a", "2026-11-03T08:00"), null);
    assert.deepEqual(at("a", "2026-11-04T08:00"), { kind: "due", day: day("2026-11-04") });
    // a one-day step: only the start
    assert.deepEqual(at("b", "2026-11-05T08:00"), { kind: "start", day: day("2026-11-05") });
    assert.equal(at("b", "2026-11-04T16:00"), null);
    assert.deepEqual(at("a", "2026-11-05T09:00"), { kind: "overdue", day: day("2026-11-05") });
  });

  it("reminds a step in hours in its first hour and in its last hour", () => {
    // a: Mon 08:00–11:00 (3 h), b: 11:00–12:00 (1 h)
    const doc = plan([step("a", 3, { duration: { amount: 3, unit: "h" } }), step("b", 1, { duration: { amount: 1, unit: "h" } })]);
    const slots = schedule(doc);
    const at = (id: string, now: string) => autoReminder(doc.steps.find((s) => s.id === id)!, slots.get(id), t(now), doc.hours)?.kind ?? null;
    assert.equal(at("a", "2026-11-02T07:00"), null);
    assert.equal(at("a", "2026-11-02T08:00"), "start");
    assert.equal(at("a", "2026-11-02T09:00"), null);
    assert.equal(at("a", "2026-11-02T10:00"), "due");
    assert.equal(at("b", "2026-11-02T11:00"), "start");
    // a one-hour step gets its end reminder at the deadline
    assert.equal(at("b", "2026-11-02T12:00"), "due");
    assert.equal(at("a", "2026-11-02T13:00"), "overdue");
  });

  it("sends nothing for a done step", () => {
    const doc = plan([step("a", 1, { status: "done" })]);
    assert.equal(autoReminder(doc.steps[0], schedule(doc).get("a"), t("2026-11-02T08:00"), doc.hours), null);
  });
});

describe("dueReminders", () => {
  it("lists the reminders due now, only inside working hours", () => {
    const doc = plan([step("a", 2), step("b", 1)]);
    const slots = schedule(doc);
    assert.deepEqual(dueReminders(doc, slots, t("2026-11-03T08:00")), [{ stepId: "a", kind: "due", day: day("2026-11-03") }]);
    assert.deepEqual(dueReminders(doc, slots, t("2026-11-04T09:00")), [
      { stepId: "a", kind: "overdue", day: day("2026-11-04") },
      { stepId: "b", kind: "start", day: day("2026-11-04") },
    ]);
    assert.deepEqual(dueReminders(doc, slots, t("2026-11-03T07:00")), []); // before work
    assert.deepEqual(dueReminders(doc, slots, t("2026-11-03T12:00")), []); // lunch
    assert.deepEqual(dueReminders(doc, slots, t("2026-11-07T08:00")), []); // Saturday
  });

  it("knows the working hours", () => {
    const { hours } = plan([]);
    assert.ok(isWorkingTime(t("2026-11-02T08:00"), hours));
    assert.ok(!isWorkingTime(t("2026-11-02T17:00"), hours));
  });
});

describe("recipientsFor", () => {
  it("looks addresses up by role name, once each", () => {
    const doc = plan([step("a", 1, { picIds: ["r_qc", "r_dev"] })]);
    const dir = new Map([
      ["qc hdbank", ["lan@hd.vn", "minh@hd.vn"]],
      ["dev fpt", ["minh@hd.vn", "an@fpt.com"]],
    ]);
    assert.deepEqual(recipientsFor(doc.steps[0], doc, dir), ["lan@hd.vn", "minh@hd.vn", "an@fpt.com"]);
  });
});

describe("buildReminderEmail", () => {
  const doc = plan([step("a", 2, { title: 'QC <b>test</b> & "ký"', note: "Xin data test" })]);
  const slots = schedule(doc);
  const base = { workflowName: "UAT → Go-live", doc, step: doc.steps[0], slot: slots.get("a")!, link: "https://app.example/workflow/x" };

  it("writes a courteous reminder with the schedule", () => {
    const mail = buildReminderEmail({ ...base, kind: "upcoming", now: t("2026-10-30T08:00") });
    assert.match(mail.subject, /^\[Nhắc việc\] Sắp bắt đầu: Bước 1 – /);
    assert.match(mail.text, /^Kính gửi Quý Anh\/Chị thuộc nhóm QC HDBank,/);
    assert.ok(mail.text.includes(`Bắt đầu: ${longMoment(t("2026-11-02T08:00"))} (T+0)`));
    assert.ok(mail.text.includes("Hạn hoàn thành: Thứ ba, 03/11/2026 lúc 17:00 (T+2)"));
    assert.ok(mail.text.includes("Xem chi tiết: https://app.example/workflow/x"));
    assert.ok(mail.text.includes("Trân trọng,\nHệ thống Workflow"));
  });

  it("tells the team a step has started", () => {
    const mail = buildReminderEmail({ ...base, kind: "start", now: t("2026-11-02T08:00") });
    assert.match(mail.subject, /^\[Nhắc việc\] Bắt đầu công việc: Bước 1 – /);
    assert.ok(mail.text.includes("đã đến thời gian bắt đầu công việc"));
  });

  it("says how late an overdue step is, in working time", () => {
    const mail = buildReminderEmail({ ...base, kind: "overdue", now: t("2026-11-05T08:00") });
    assert.match(mail.subject, /Trễ hạn 1 ngày/);
  });

  it("escapes what people typed in the HTML", () => {
    const mail = buildReminderEmail({ ...base, kind: "due", now: t("2026-11-03T08:00"), sentBy: "<script>" });
    assert.ok(!mail.html.includes("<b>test</b>") && mail.html.includes("&lt;b&gt;test&lt;/b&gt; &amp; &quot;ký&quot;"));
    assert.ok(mail.html.includes("&lt;script&gt;") && !mail.html.includes("<script>"));
  });
});

describe("confirmation requests", () => {
  it("groups unconfirmed, unfinished steps by role", () => {
    const doc = plan([
      step("a", 1),
      step("b", 1, { picIds: ["r_qc", "r_dev"] }),
      step("c", 1, { confirmed: { at: "x", by: "Lan", role: "QC" } }),
      step("d", 1, { status: "done" }),
    ]);
    assert.deepEqual(confirmDigests(doc), [
      { roleId: "r_qc", roleName: "QC HDBank", stepIds: ["a", "b"] },
      { roleId: "r_dev", roleName: "DEV FPT", stepIds: ["b"] },
    ]);
  });

  it("asks one role to confirm its steps, politely", () => {
    const doc = plan([step("a", 2), step("b", 1)]);
    const slots = schedule(doc);
    const mail = buildConfirmEmail({ workflowName: "UAT", doc, roleName: "QC HDBank", steps: doc.steps.map((s) => ({ step: s, slot: slots.get(s.id)! })), link: "https://x/workflow/1" });
    assert.equal(mail.subject, "[Xác nhận timeline] UAT: 2 bước của nhóm QC HDBank cần xác nhận");
    assert.match(mail.text, /^Kính gửi Quý Anh\/Chị thuộc nhóm QC HDBank,/);
    assert.ok(mail.text.includes("• Bước 1: Bước a\n  Thời lượng: 2 ngày · Bắt đầu: Thứ hai, 02/11/2026 lúc 08:00 · Hạn: Thứ ba, 03/11/2026 lúc 17:00"));
    assert.ok(mail.html.includes("Mở workflow để xác nhận"));
  });
});
