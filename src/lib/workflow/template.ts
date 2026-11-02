import { autoLayout, blankDoc, type WorkflowDoc, type WorkflowRole, type WorkflowStep } from "./model.ts";

const ROLES: WorkflowRole[] = [
  { id: "r_devfpt", name: "DEV FPT", color: "violet" },
  { id: "r_qcfpt", name: "QC FPT", color: "sky" },
  { id: "r_qchd", name: "QC HDBank", color: "emerald" },
  { id: "r_devhd", name: "DEV HDBank", color: "amber" },
];

// [title as the team wrote it, PIC role ids, length in working days]. Step 1 is "T+2" in the source
// plan; the other lengths are placeholders for the team to set on the board.
const STEPS: [string, string[], number][] = [
  ["Dev kiểm tra tài liệu API đã cung cấp đầy đủ chưa và bắt đầu start dev.(T+2). xin data test.", ["r_devfpt"], 2],
  ["Bắt đầu start dev.", ["r_devfpt"], 5],
  ["bàn giao UAT QC FPT.", ["r_devfpt"], 1],
  ["QC FPT test. Kiểm tra timelime bàn giao.", ["r_qcfpt"], 3],
  ["QC log bug, retest. QC FPT Hoàn thành test.", ["r_qcfpt"], 3],
  [
    "QC FPT demo bàn giao cho QC HDBank, DEV FPT gửi tài liệu kỹ thuật cho HDBank. DEV HDBank lên kế hoạch bàn giao quét pendtest.",
    ["r_qcfpt", "r_devfpt", "r_devhd"],
    2,
  ],
  ["QC HD log bug(trả bàn giao...). và time line hoàn thành test UAT.", ["r_qchd"], 3],
  ["DEV FPT gửi mer request lên Pre-pilot.", ["r_devfpt"], 1],
  ["DEV HDBank build Pre-pilot.", ["r_devhd"], 1],
  ["QC FPT+HD retest funtion Pre.", ["r_qcfpt", "r_qchd"], 2],
  ["QC FPT+HD checklist pre-pilot.", ["r_qcfpt", "r_qchd"], 1],
  ["DEV  FPT gửi MB09 hoàn thành tính năng golive.", ["r_devfpt"], 1],
];

export const EXAMPLE_NAME = "Quy trình UAT → Pre-pilot → Go-live";

/** The UAT → Pre-pilot → Go-live plan from the team's example, starting on the next working day. */
export function exampleDoc(today: string): WorkflowDoc {
  const doc = blankDoc(today);
  doc.description = "Mẫu: bàn giao từ DEV FPT sang QC FPT, QC HDBank, lên Pre-pilot và Go-live.";
  doc.roles = ROLES.map((r) => ({ ...r }));
  const steps: WorkflowStep[] = STEPS.map(([title, picIds, days], i) => ({
    id: `s_step${String(i + 1).padStart(2, "0")}`,
    title,
    note: "",
    picIds,
    duration: { amount: days, unit: "d" },
    status: "todo",
    position: { x: 0, y: 0 },
    confirmed: null,
  }));
  doc.edges = steps.slice(1).map((s, i) => ({ id: `e_${steps[i].id}_${s.id}`, source: steps[i].id, target: s.id }));
  doc.steps = autoLayout(steps, doc.edges);
  return doc;
}
