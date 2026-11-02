import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { blankDoc, parseStamp, schedule, type WorkflowDoc, type WorkflowStep } from "../workflow/model.ts";
import { buildConfirmEmail, buildReminderEmail, confirmDigests, dueReminders, longMoment, recipientsFor, reminderKind, wallNow } from "../workflow/reminders.ts";

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

  it("only sends a progress note by hand", () => {
    assert.equal(kind("a", "2026-11-02T10:00"), null);
    assert.equal(kind("a", "2026-11-02T10:00", true), "progress");
    assert.equal(kind("c", "2026-11-02T10:00", true), "upcoming");
  });
});

describe("dueReminders", () => {
  it("lists today's reminders and sends none on days off", () => {
    const doc = plan([step("a", 2), step("b", 1)]);
    const slots = schedule(doc);
    assert.deepEqual(dueReminders(doc, slots, t("2026-11-03T08:00")), [
      { stepId: "a", kind: "due" },
      { stepId: "b", kind: "upcoming" },
    ]);
    assert.deepEqual(dueReminders(doc, slots, t("2026-11-07T08:00")), []); // Saturday
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
