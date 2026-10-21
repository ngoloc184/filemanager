// End-to-end conversations through agentTurn() with a small in-memory stand-in
// for the Supabase client: checks that tools query the right rows, ask for
// choices, sign confirmations and call the right RPCs when executed.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Lesson, LessonStore } from "@ai-pro/agent-core";
import { agentTurn, fileAgent } from "../agent/index.ts";
import { signAgentAction, verifyAgentAction } from "../agent/token.ts";
import { EMPTY_CONTEXT, type ConversationContext } from "../assistant/context.ts";
import type { AssistantReply } from "../assistant/types.ts";

const KEY = Buffer.from("t".repeat(32));
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ME = id(999);

type Row = Record<string, unknown>;

function fakeDb() {
  const tables: Record<string, Row[]> = {
    folders: [
      { id: id(1), name: "Kế toán", parent_id: null, owner_id: ME, deleted_at: null },
      { id: id(2), name: "Dự án", parent_id: null, owner_id: ME, deleted_at: null },
      { id: id(3), name: "Hóa đơn", parent_id: id(1), owner_id: ME, deleted_at: null },
    ],
    files: [
      { id: id(10), name: "Hợp đồng.docx", folder_id: null, owner_id: ME, extension: "docx", mime_type: "application/msword", size: 10, updated_at: "2026-10-01", deleted_at: null, current_version_id: id(110) },
      { id: id(11), name: "Báo cáo Q3.pdf", folder_id: null, owner_id: ME, extension: "pdf", mime_type: "application/pdf", size: 20, updated_at: "2026-10-02", deleted_at: null, current_version_id: id(111) },
      { id: id(12), name: "Báo cáo Q4.pdf", folder_id: null, owner_id: ME, extension: "pdf", mime_type: "application/pdf", size: 30, updated_at: "2026-10-03", deleted_at: null, current_version_id: id(112) },
      { id: id(13), name: "Chi phí.xlsx", folder_id: id(1), owner_id: ME, extension: "xlsx", mime_type: "application/vnd.ms-excel", size: 40, updated_at: "2026-10-04", deleted_at: null, current_version_id: id(113) },
    ],
    saved_links: [],
  };
  const calls: { fn: string; args: Row }[] = [];

  type Result = { data: unknown; error: null };

  class Query implements PromiseLike<Result> {
    private rows: Row[];
    private single = false;
    private table: string;
    constructor(table: string) {
      this.table = table;
      this.rows = [...(tables[table] ?? [])];
    }
    select() {
      return this;
    }
    eq(c: string, v: unknown) {
      this.rows = this.rows.filter((r) => r[c] === v);
      return this;
    }
    is(c: string, v: unknown) {
      this.rows = this.rows.filter((r) => r[c] === v);
      return this;
    }
    not(c: string, _op: string, v: unknown) {
      this.rows = this.rows.filter((r) => r[c] !== v);
      return this;
    }
    in(c: string, vs: unknown[]) {
      this.rows = this.rows.filter((r) => vs.includes(r[c]));
      return this;
    }
    ilike(c: string, pattern: string) {
      const inner = pattern.slice(1, -1).replace(/\\([%_\\])/g, "$1").toLowerCase();
      this.rows = this.rows.filter((r) => String(r[c]).toLowerCase().includes(inner));
      return this;
    }
    order(c: string, opts?: { ascending?: boolean }) {
      const dir = opts?.ascending === false ? -1 : 1;
      this.rows.sort((a, b) => (String(a[c]) < String(b[c]) ? -dir : dir));
      return this;
    }
    limit(n: number) {
      this.rows = this.rows.slice(0, n);
      return this;
    }
    maybeSingle() {
      this.single = true;
      return this;
    }
    insert(row: Row) {
      tables[this.table].push({ id: id(500 + tables[this.table].length), ...row });
      calls.push({ fn: `insert:${this.table}`, args: row });
      this.rows = [row];
      return this;
    }
    then<A = Result, B = never>(
      ok?: ((v: Result) => A | PromiseLike<A>) | null,
      fail?: ((e: unknown) => B | PromiseLike<B>) | null
    ): PromiseLike<A | B> {
      const data = this.single ? (this.rows[0] ?? null) : this.rows;
      return Promise.resolve<Result>({ data, error: null }).then(ok, fail);
    }
  }

  const supabase = {
    from: (table: string) => new Query(table),
    rpc(fn: string, args: Row) {
      calls.push({ fn, args });
      let data: unknown = null;
      if (fn === "get_folder_ancestors") {
        const chain: Row[] = [];
        let cur = tables.folders.find((f) => f.id === args.p_id);
        while (cur) {
          chain.unshift(cur);
          cur = tables.folders.find((f) => f.id === cur!.parent_id);
        }
        data = chain;
      }
      if (fn === "create_folder") data = { id: id(77), name: args.p_name };
      const result = { data, error: null };
      return Object.assign(Promise.resolve(result), { select: () => ({ single: () => Promise.resolve(result) }) });
    },
  };
  return { supabase, calls, tables };
}

function memoryLessons(): LessonStore {
  const lessons: Lesson[] = [];
  return {
    list: async () => lessons,
    teach: async (i) => {
      const l: Lesson = { id: id(900 + lessons.length), phrase: i.phrase, canonical: i.canonical, scope: "mine" };
      lessons.push(l);
      return l;
    },
    vote: async () => {},
  };
}

function conversation(engine?: (message: string, ctx: ConversationContext) => AssistantReply) {
  const db = fakeDb();
  const lessons = memoryLessons();
  let context: ConversationContext & { agent?: unknown } = EMPTY_CONTEXT;
  const say = async (message: string, choice: string | null = null) => {
    const { reply, context: next } = await agentTurn({
      message,
      choice,
      context,
      agentState: context.agent,
      ctx: { supabase: db.supabase as never, userId: ME },
      lessons,
      runEngine: async (text, ctx) =>
        engine?.(text, ctx) ?? { intent: "out_of_scope", text: "Tôi chỉ hỗ trợ file.", engine: "local", context: ctx },
      sign: (tool, params) => signAgentAction(ME, tool, params, Date.now(), KEY),
      tuningVersion: "test",
    });
    context = next;
    return reply;
  };
  const confirm = async (reply: AssistantReply) => {
    const verified = verifyAgentAction(reply.action!.token, ME, Date.now(), KEY);
    assert.ok(verified.ok);
    return fileAgent.execute(verified.tool, verified.params, { supabase: db.supabase as never, userId: ME, engine: async () => ({}) as never });
  };
  return { db, say, confirm };
}

describe("agent flow", () => {
  it("adds a file to a folder after confirmation", async () => {
    const { db, say, confirm } = conversation();
    const r = await say("Thêm file Hợp đồng.docx vào thư mục Kế toán");
    assert.equal(r.intent, "agent:move_file");
    assert.equal(r.action?.summary, "Chuyển “Hợp đồng.docx” vào “Kế toán”.");
    assert.equal(db.calls.filter((c) => c.fn === "move_file").length, 0, "nothing changes before confirmation");
    assert.deepEqual(await confirm(r), { ok: true, message: "Đã chuyển file.", openUrl: `/dashboard?folder=${id(1)}&file=${id(10)}` });
    assert.deepEqual(db.calls.find((c) => c.fn === "move_file")?.args, { p_id: id(10), p_folder_id: id(1) });
  });

  it("asks which file when the name is ambiguous, then continues", async () => {
    const { say } = conversation();
    const ask = await say("chuyển báo cáo vào thư mục Dự án");
    assert.deepEqual(ask.choices?.map((c) => c.fileId).sort(), [id(11), id(12)]);
    const r = await say("chuyển báo cáo vào thư mục Dự án", id(12));
    assert.equal(r.action?.summary, "Chuyển “Báo cáo Q4.pdf” vào “Dự án”.");
  });

  it("asks for a missing detail", async () => {
    const { say } = conversation();
    const ask = await say("bình luận vào file Hợp đồng.docx");
    assert.match(ask.text, /bình luận gì/);
    const r = await say("Đã duyệt.\nChờ ký.");
    assert.match(r.action?.summary ?? "", /Đã duyệt\.\nChờ ký\./);
  });

  it("creates a folder inside another folder", async () => {
    const { db, say, confirm } = conversation();
    const r = await say("Tạo thư mục Hóa đơn 2027 trong thư mục Kế toán");
    assert.equal(r.action?.summary, "Tạo thư mục “Hóa đơn 2027” trong “Kế toán”.");
    await confirm(r);
    assert.deepEqual(db.calls.find((c) => c.fn === "create_folder")?.args, { p_parent_id: id(1), p_name: "Hóa đơn 2027", p_comment: null });
  });

  it("lists a folder and remembers its files for references", async () => {
    const { say } = conversation();
    const list = await say("Trong thư mục Kế toán có gì?");
    assert.deepEqual(list.folders?.map((f) => f.name), ["Hóa đơn"]);
    assert.deepEqual(list.files?.map((f) => f.name), ["Chi phí.xlsx"]);
    const r = await say("chuyển nó vào thư mục Dự án");
    assert.equal(r.action?.summary, "Chuyển “Chi phí.xlsx” vào “Dự án”.");
  });

  it("saves a link", async () => {
    const { db, say, confirm } = conversation();
    const r = await say("Lưu link https://example.com/tien-do tiêu đề Link cập nhật tiến độ mỗi ngày");
    await confirm(r);
    assert.deepEqual(db.tables.saved_links.map((l) => [l.title, l.url]), [["Link cập nhật tiến độ mỗi ngày", "https://example.com/tien-do"]]);
  });

  it("shares references with the engine: its results feed the agent's tools", async () => {
    const { say } = conversation((text, ctx) =>
      /tìm/i.test(text)
        ? { intent: "find", text: "2 file", engine: "local", context: { ...ctx, results: [id(11), id(12)], focus: null } }
        : { intent: "out_of_scope", text: "?", engine: "local", context: ctx }
    );
    const found = await say("tìm báo cáo");
    assert.equal(found.intent, "find");
    const r = await say("chuyển file thứ hai vào thư mục Dự án");
    assert.equal(r.action?.summary, "Chuyển “Báo cáo Q4.pdf” vào “Dự án”.");
  });

  it("offers an upload button for the folder", async () => {
    const { say } = conversation();
    const r = await say("thêm file vào folder Dự án");
    assert.deepEqual(r.upload, { folderId: id(2), folderName: "Dự án" });
  });

  it("learns a new way of saying a command", async () => {
    const { say } = conversation();
    await say('Khi tôi nói "quăng" nghĩa là "chuyển"');
    const r = await say("quăng Hợp đồng.docx vào thư mục Dự án");
    assert.equal(r.action?.summary, "Chuyển “Hợp đồng.docx” vào “Dự án”.");
    assert.equal(r.lessonIds?.length, 1);
  });

  it("hands look-alike commands to the engine when nothing matches", async () => {
    const seen: string[] = [];
    const { say } = conversation((text, ctx) => {
      seen.push(text);
      return { intent: "ask", text: "engine", engine: "local", context: ctx };
    });
    const messages = ["Xem thư mục nào lớn nhất", "lấy lại mật khẩu", "copy link", "chuyển khoản vào tài khoản công ty tháng 9"];
    for (const m of messages) {
      const r = await say(m);
      assert.equal(r.intent, "ask", m);
    }
    assert.deepEqual(seen, messages);
  });

  it("“nó” in a later step means the item of the earlier step", async () => {
    const { say } = conversation();
    const first = await say("chuyển Hợp đồng.docx vào thư mục Dự án rồi đổi tên nó thành HĐ ký");
    assert.equal(first.action?.summary, "Chuyển “Hợp đồng.docx” vào “Dự án”.");
    const next = await say("tiếp tục");
    assert.equal(next.action?.summary, "Đổi tên “Hợp đồng.docx” thành “HĐ ký.docx”.");
  });

  it("“nó” without anything to refer to asks instead of searching for “nó”", async () => {
    const { say } = conversation();
    const r = await say("xóa nó");
    assert.match(r.text, /nói tới file nào/);
  });

  it("never signs anything when actions are not configured", async () => {
    const db = fakeDb();
    const { reply } = await agentTurn({
      message: "Xóa file Hợp đồng.docx",
      choice: null,
      context: EMPTY_CONTEXT,
      agentState: undefined,
      ctx: { supabase: db.supabase as never, userId: ME },
      runEngine: async () => ({ intent: "x", text: "", engine: "local" }),
      tuningVersion: "test",
    });
    assert.equal(reply.action, null);
    assert.match(reply.text, /chưa được bật/);
  });
});
