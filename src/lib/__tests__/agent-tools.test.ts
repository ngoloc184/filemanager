import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileAgent } from "../agent/index.ts";
import { FILE_MANAGER_TOOLS } from "../agent/tools.ts";
import { signAgentAction, verifyAgentAction } from "../agent/token.ts";
import { parseQuestion } from "../assistant/intent.ts";
import { CASES } from "../assistant/eval/cases.ts";
import { HOLDOUT } from "../assistant/eval/cases-holdout.ts";

describe("file agent: understanding", () => {
  it("understands every example with its own tool", () => {
    for (const tool of FILE_MANAGER_TOOLS) {
      for (const example of tool.examples) {
        assert.equal(fileAgent.understand(example)?.tool.name, tool.name, example);
      }
    }
  });

  const cases: [string, string, Record<string, string>][] = [
    ["Thêm file Hợp đồng.docx vào thư mục Kế toán", "move_file", { file: "file Hợp đồng.docx", folder: "Kế toán" }],
    ["chuyển file thứ hai vào thư mục gốc", "move_file", { file: "file thứ hai", folder: "gốc" }],
    ["Hãy đưa báo cáo Q3.pdf sang folder Lưu trữ nhé", "move_file", { file: "báo cáo Q3.pdf", folder: "Lưu trữ" }],
    ["thêm file vào folder Dự án", "upload_to_folder", { folder: "Dự án" }],
    ["Tải file lên thư mục Kế toán", "upload_to_folder", { folder: "Kế toán" }],
    ["Tạo thư mục Hóa đơn trong thư mục Kế toán", "create_folder", { name: "Hóa đơn", parent: "Kế toán" }],
    ["tạo folder mới tên là Dự án 2027", "create_folder", { name: "Dự án 2027" }],
    ["Đổi tên thư mục Cũ thành Lưu trữ", "rename", { folder: "Cũ", name: "Lưu trữ" }],
    ["đổi tên file thứ hai thành Báo cáo Q3", "rename", { file: "file thứ hai", name: "Báo cáo Q3" }],
    ["Xóa thư mục Cũ", "trash", { folder: "Cũ" }],
    ["xóa file Bản nháp.docx", "trash", { file: "file Bản nháp.docx" }],
    ["Khôi phục file Bản nháp.docx", "restore", { file: "file Bản nháp.docx" }],
    ["Sao chép file Báo cáo.pdf vào thư mục Lưu trữ", "copy_file", { file: "file Báo cáo.pdf", folder: "Lưu trữ" }],
    ["Chuyển thư mục Hóa đơn vào thư mục Kế toán", "move_folder", { folder: "Hóa đơn", dest: "Kế toán" }],
    [
      "Lưu link https://example.com/tien-do?d=1 tiêu đề Link cập nhật tiến độ mỗi ngày",
      "save_link",
      { url: "https://example.com/tien-do?d=1", title: "Link cập nhật tiến độ mỗi ngày" },
    ],
    ["Bình luận vào file Hợp đồng.docx rằng đã duyệt, chờ ký", "add_comment", { file: "file Hợp đồng.docx", body: "đã duyệt, chờ ký" }],
    ["Tạo file ghi chú.txt nội dung Họp lúc 9h", "create_text_file", { name: "ghi chú.txt", content: "Họp lúc 9h" }],
    ["Trong thư mục Dự án có gì?", "list_folder", { folder: "Dự án" }],
    ["Chia sẻ thư mục Dự án với An@Example.com quyền chỉnh sửa", "share", { folder: "Dự án", email: "an@example.com", role: "editor" }],
    ["Xem thùng rác", "list_trash", {}],
    ["xem các link đã lưu", "list_links", {}],
    ["Xóa vĩnh viễn file cũ", "refuse_permanent_delete", { item: "file cũ" }],
  ];

  for (const [message, tool, args] of cases) {
    it(`“${message}” → ${tool}`, () => {
      const u = fileAgent.understand(message);
      assert.equal(u?.tool.name, tool);
      assert.deepEqual(u?.args, args);
    });
  }
});

describe("file agent: does not take over the assistant's questions", () => {
  // Only file operations may be captured by agent tools; searches, questions
  // about documents, summaries, comparisons, exports and memory commands
  // must still reach the assistant engine unchanged.
  const OPERATIONS = new Set(["create_folder", "rename", "move", "share", "refuse"]);
  const messages = [...CASES, ...HOLDOUT].flatMap((c) => c.turns.map((t) => t.say));

  it(`routes all ${messages.length} evaluation messages correctly`, () => {
    const hijacked = messages.filter((m) => fileAgent.understand(m) && !OPERATIONS.has(parseQuestion(m).kind));
    assert.deepEqual(hijacked, []);
  });

  for (const m of [
    "Cho tôi các file gửi tới khách hàng",
    "Thêm ghi chú vào hợp đồng",
    "để file báo cáo sang tuần sau",
    "Tạo file báo cáo tháng 9",
    "Tìm giúp tôi file báo cáo doanh thu quý 3",
    "tìm file nói về chuyển khoản vào tháng 9",
    "Tóm tắt file thứ hai",
    "So sánh hai hợp đồng này",
    "Xuất bảng so sánh ra file Excel",
    "Hãy nhớ HĐ nghĩa là hợp đồng",
    "file nào nhắc đến việc chuyển hàng vào kho",
  ]) {
    it(`leaves “${m}” to the engine`, () => assert.equal(fileAgent.understand(m), null));
  }
});

describe("file agent: confirmation tokens", () => {
  const key = Buffer.from("k".repeat(32));

  it("round-trips for the same user only", () => {
    const token = signAgentAction("u1", "trash", { kind: "file", id: "x" }, 1000, key);
    assert.deepEqual(verifyAgentAction(token, "u1", 2000, key), { ok: true, tool: "trash", params: { kind: "file", id: "x" }, nonce: (verifyAgentAction(token, "u1", 2000, key) as { nonce: string }).nonce });
    assert.deepEqual(verifyAgentAction(token, "u2", 2000, key), { ok: false, reason: "user" });
  });

  it("rejects expired and tampered tokens", () => {
    const token = signAgentAction("u1", "trash", { id: "x" }, 1000, key);
    assert.deepEqual(verifyAgentAction(token, "u1", 1000 + 11 * 60_000, key), { ok: false, reason: "expired" });
    const [prefix, payload, sig] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ u: "u1", t: "share", p: { id: "x" }, e: 9e15, n: "n" })).toString("base64url");
    assert.deepEqual(verifyAgentAction(`${prefix}.${forged}.${sig}`, "u1", 2000, key), { ok: false, reason: "invalid" });
    assert.equal(verifyAgentAction(`${prefix}.${payload}.${sig}`, "u1", 2000, Buffer.from("x".repeat(32))).ok, false);
  });

  it("only write tools can be executed", async () => {
    const ctx = { supabase: {} as never, userId: "u", engine: async () => ({}) as never };
    assert.equal((await fileAgent.execute("list_trash", {}, ctx)).ok, false);
    for (const tool of FILE_MANAGER_TOOLS.filter((t) => t.effect === "write")) {
      assert.equal(typeof tool.execute, "function", tool.name);
    }
  });
});
