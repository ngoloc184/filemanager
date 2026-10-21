import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createAgent, resolveReference } from "../agent.ts";
import { fold } from "../text.ts";
import type { AgentState, Lesson, LessonStore, TeachInput, Tool } from "../types.ts";

// ---------------------------------------------------------------- a tiny host
type Ctx = { files: { id: string; name: string; folder: string | null }[]; folders: { id: string; name: string }[]; log: string[] };
type R = { files?: { id: string; name: string }[] };

const host = (): Ctx => ({
  files: [
    { id: "f1", name: "Báo cáo Q3.pdf", folder: null },
    { id: "f2", name: "Báo cáo Q4.pdf", folder: null },
    { id: "f3", name: "Hợp đồng.docx", folder: null },
  ],
  folders: [
    { id: "d1", name: "Kế toán" },
    { id: "d2", name: "Dự án" },
  ],
  log: [],
});

const findFiles = (ctx: Ctx, q: string) => ctx.files.filter((f) => fold(f.name).includes(fold(q).replace(/^(file|tep) /, "")));

const tools: Tool<Ctx, R>[] = [
  {
    name: "list_files",
    title: "Liệt kê file",
    description: "",
    effect: "read",
    patterns: ["(tim|liet ke) (file|tep)? {query}"],
    examples: ["tìm file báo cáo"],
    slots: { query: { required: true, ask: "Tìm gì?" } },
    async run({ args, ctx }) {
      const found = findFiles(ctx, args.query);
      return { type: "done", text: `${found.length} file`, reply: { files: found }, memory: { items: found.map((f) => f.id), focus: found.length === 1 ? found[0].id : null } };
    },
  },
  {
    name: "move_file",
    title: "Chuyển file vào thư mục",
    description: "",
    effect: "write",
    patterns: ["(chuyen|di chuyen|dua|them) {file} (vao|sang|toi) (thu muc|folder)? {folder}", "(chuyen|di chuyen|dua|them) {file}"],
    examples: ["chuyển file Hợp đồng.docx vào thư mục Kế toán"],
    slots: { file: { required: true, ask: "Bạn muốn chuyển file nào?" }, folder: { required: true, ask: "Chuyển vào thư mục nào?" } },
    async run({ args, picked, ctx, memory }) {
      const fileId = picked.file ?? resolveReference(args.file, memory);
      let file = fileId ? ctx.files.find((f) => f.id === fileId) : undefined;
      if (!file) {
        const found = findFiles(ctx, args.file);
        if (found.length > 1) return { type: "choose", slot: "file", text: "File nào?", choices: found.map((f) => ({ value: f.id, label: f.name })) };
        file = found[0];
      }
      if (!file) return { type: "error", text: "Không tìm thấy file." };
      const folder = picked.folder ? ctx.folders.find((d) => d.id === picked.folder) : ctx.folders.find((d) => fold(d.name) === fold(args.folder));
      if (!folder) return { type: "ask", slot: "folder", text: `Không có thư mục “${args.folder}”. Thư mục nào?` };
      return { type: "confirm", title: "Chuyển file", summary: `Chuyển “${file.name}” vào “${folder.name}”`, params: { fileId: file.id, folderId: folder.id } };
    },
    async execute(params, ctx) {
      ctx.log.push(`move ${params.fileId} -> ${params.folderId}`);
      return { ok: true, message: "Đã chuyển." };
    },
  },
  {
    name: "share",
    title: "Chia sẻ",
    description: "",
    effect: "write",
    patterns: ["chia se {file} (voi|cho) {email} (quyen)? {role?}"],
    examples: ["chia sẻ Hợp đồng.docx với a@b.com quyền xem"],
    slots: { email: { type: "email", ask: "E-mail?" }, role: { type: "role", ask: "Quyền?" } },
    async run({ args }) {
      return { type: "confirm", title: "Chia sẻ", summary: `${args.file} → ${args.email} (${args.role ?? "viewer"})`, params: args };
    },
  },
];

function memoryStore(): LessonStore & { taught: TeachInput[]; votes: [string[], number][]; lessons: Lesson[] } {
  const taught: TeachInput[] = [];
  const votes: [string[], number][] = [];
  const lessons: Lesson[] = [];
  return {
    taught,
    votes,
    lessons,
    async list() {
      return lessons;
    },
    async teach(input) {
      taught.push(input);
      if (input.source !== "explicit") return null;
      const lesson: Lesson = { id: `l${lessons.length + 1}`, phrase: input.phrase, canonical: input.canonical, scope: "mine" };
      lessons.push(lesson);
      return lesson;
    },
    async vote(ids, vote) {
      votes.push([ids, vote]);
    },
    async forget(id) {
      const i = lessons.findIndex((l) => l.id === id);
      if (i >= 0) lessons.splice(i, 1);
    },
  };
}

const fallback = async (message: string) =>
  /^tom tat/.test(fold(message))
    ? { text: "Tóm tắt…", understood: true }
    : { text: "Tôi chỉ hỗ trợ file.", understood: false };

function agentWith(store = memoryStore()) {
  return createAgent<Ctx, R>({ tools, lessons: store, fallback, fallbackUnderstands: (f) => /^tom tat/.test(f) });
}

async function talk(agent: ReturnType<typeof agentWith>, ctx: Ctx, messages: (string | { choice: string })[]) {
  let state: AgentState | undefined;
  const replies = [];
  for (const m of messages) {
    const r = await agent.handle(typeof m === "string" ? { message: m, state } : { message: "", choice: m.choice, state }, ctx);
    state = r.state;
    replies.push(r);
  }
  return replies;
}

// ---------------------------------------------------------------- tests
describe("agent: understanding and dialogue", () => {
  it("runs a read tool and remembers the results", async () => {
    const [r] = await talk(agentWith(), host(), ["Tìm file báo cáo"]);
    assert.equal(r.trace.tools[0], "list_files");
    assert.equal(r.reply?.files?.length, 2);
    assert.deepEqual(r.state.memory.items, ["f1", "f2"]);
  });

  it("asks for confirmation before a write and executes only on request", async () => {
    const ctx = host();
    const agent = agentWith();
    const [r] = await talk(agent, ctx, ["Hãy chuyển file Hợp đồng.docx vào thư mục Kế toán nhé"]);
    assert.equal(r.confirm?.summary, "Chuyển “Hợp đồng.docx” vào “Kế toán”");
    assert.deepEqual(ctx.log, []);
    assert.deepEqual(await agent.execute(r.confirm!.tool, r.confirm!.params, ctx), { ok: true, message: "Đã chuyển." });
    assert.deepEqual(ctx.log, ["move f3 -> d1"]);
  });

  it("asks for a missing slot and continues with the answer", async () => {
    const [ask, done] = await talk(agentWith(), host(), ["chuyển Hợp đồng.docx", "Dự án"]);
    assert.equal(ask.text, "Chuyển vào thư mục nào?");
    assert.equal(done.confirm?.params.folderId, "d2");
  });

  it("offers choices for ambiguous names (click or number)", async () => {
    const agent = agentWith();
    const [choose, picked] = await talk(agent, host(), ["chuyển báo cáo vào Kế toán", { choice: "f2" }]);
    assert.deepEqual(choose.choices?.map((c) => c.value), ["f1", "f2"]);
    assert.equal(picked.confirm?.params.fileId, "f2");
    const [, byNumber] = await talk(agent, host(), ["chuyển báo cáo vào Kế toán", "1"]);
    assert.equal(byNumber.confirm?.params.fileId, "f1");
  });

  it("resolves references to earlier results", async () => {
    const [, r] = await talk(agentWith(), host(), ["tìm báo cáo", "chuyển file thứ hai vào Dự án"]);
    assert.deepEqual(r.confirm?.params, { fileId: "f2", folderId: "d2" });
  });

  it("cancels a pending question", async () => {
    const [, r] = await talk(agentWith(), host(), ["chuyển Hợp đồng.docx", "thôi"]);
    assert.equal(r.state.pending, null);
    assert.match(r.text, /Đã hủy/);
  });

  it("a new request replaces a pending question", async () => {
    const [, r] = await talk(agentWith(), host(), ["chuyển Hợp đồng.docx", "tìm hợp đồng"]);
    assert.equal(r.trace.tools[0], "list_files");
  });

  it("validates typed slots", async () => {
    const [ok] = await talk(agentWith(), host(), ["chia sẻ Hợp đồng.docx với An@Example.com quyền chỉnh sửa"]);
    assert.equal(ok.confirm?.params.email, "an@example.com");
    assert.equal(ok.confirm?.params.role, "editor");
    const [bad] = await talk(agentWith(), host(), ["chia sẻ Hợp đồng.docx với an quyền xem"]);
    assert.notEqual(bad.trace.tools[0], "share");
  });

  it("runs multi-step requests and waits at a confirmation", async () => {
    const [r, next] = await talk(agentWith(), host(), ["tìm hợp đồng rồi chuyển nó vào Kế toán"]
      .concat(["tiếp tục"]));
    assert.equal(r.trace.steps, 2);
    assert.equal(r.reply?.files?.length, 1);
    assert.deepEqual(r.confirm?.params, { fileId: "f3", folderId: "d1" });
    assert.match(next.text, /Không còn bước nào/);
  });

  it("keeps line breaks in multi-line slots", async () => {
    const note: Tool<Ctx, R> = {
      name: "note",
      title: "Ghi chú",
      description: "",
      effect: "read",
      patterns: ["ghi chu {text?}"],
      examples: ["ghi chú mua sữa"],
      slots: { text: { required: true, multiline: true, ask: "Nội dung?" } },
      async run({ args }) {
        return { type: "done", text: args.text };
      },
    };
    const agent = createAgent<Ctx, R>({ tools: [note] });
    const [, r] = await talk(agent as never, host(), ["ghi chu", "  Dòng 1.\nDòng 2!  "]);
    assert.equal(r.text, "Dòng 1.\nDòng 2!");
  });

  it("hands unknown messages to the fallback", async () => {
    const [r] = await talk(agentWith(), host(), ["tóm tắt hợp đồng"]);
    assert.equal(r.trace.handledBy, "fallback");
  });

  it("lists capabilities on help", async () => {
    const [r] = await talk(agentWith(), host(), ["bạn làm được gì"]);
    assert.match(r.text, /Chuyển file vào thư mục/);
  });
});

describe("agent: learning", () => {
  it("learns an explicit lesson and applies it next time", async () => {
    const store = memoryStore();
    const agent = agentWith(store);
    const [taught, used] = await talk(agent, host(), ['Khi tôi nói "cất" nghĩa là "chuyển"', "cất Hợp đồng.docx vào Kế toán"]);
    assert.match(taught.text, /Đã ghi nhớ/);
    assert.equal(store.taught[0].effect, "write");
    assert.deepEqual(used.confirm?.params, { fileId: "f3", folderId: "d1" });
    assert.deepEqual(used.trace.lessons, ["l1"]);
  });

  it("refuses to redefine phrases it already understands", async () => {
    const [r] = await talk(agentWith(), host(), ["Dạy: tìm báo cáo => chuyển báo cáo vào Kế toán"]);
    assert.match(r.text, /đã hiểu câu này/);
  });

  it("refuses lessons with personal data or unknown targets", async () => {
    const [secret, unknown] = await talk(agentWith(), host(), ["Dạy: gửi sếp => chia sẻ x với boss@corp.com", "Dạy: abc => xyz"]);
    assert.match(secret.text, /không học/);
    assert.match(unknown.text, /chưa hiểu câu đích/);
  });

  it("marks lessons made only of agent words as shareable", async () => {
    const store = memoryStore();
    await talk(agentWith(store), host(), ["Dạy: kiếm => tìm", "Dạy: lục => tìm file Hợp đồng"]);
    assert.equal(store.taught[0].generic, true);
    assert.equal(store.taught[1].generic, false);
  });

  it("observes a failed message followed by a rephrasing that worked", async () => {
    const store = memoryStore();
    const [, worked] = await talk(agentWith(store), host(), ["lôi hợp đồng ra", "tìm hợp đồng"]);
    assert.equal(store.taught[0]?.source, "implicit");
    assert.equal(store.taught[0]?.phrase, "loi hop dong ra");
    assert.ok(worked.suggestions?.[0]?.startsWith("Dạy: lôi hợp đồng ra => tìm hợp đồng"));
  });

  it("votes down the lessons of the previous answer on “sai rồi”", async () => {
    const store = memoryStore();
    await talk(agentWith(store), host(), ['Khi tôi nói "kiếm" nghĩa là "tìm"']);
    const agent = agentWith(store);
    const [, wrong] = await talk(agent, host(), ["kiếm báo cáo", "sai rồi"]);
    assert.deepEqual(store.votes, [[["l1"], -1]]);
    assert.match(wrong.text, /Cảm ơn/);
  });

  it("forgets a lesson", async () => {
    const store = memoryStore();
    await talk(agentWith(store), host(), ['Khi tôi nói "kiếm" nghĩa là "tìm"', "quên cách nói kiếm"]);
    assert.equal(store.lessons.length, 0);
  });
});

describe("agent: lessons from storage are re-checked", () => {
  const withLessons = (lessons: Lesson[]) => {
    const store = memoryStore();
    store.lessons.push(...lessons);
    return agentWith(store);
  };

  it("ignores shared lessons that would lead to a write", async () => {
    const agent = withLessons([{ id: "g1", phrase: "cat", canonical: "chuyen", scope: "global" }]);
    const [r] = await talk(agent, host(), ["cất Hợp đồng.docx vào Kế toán"]);
    assert.equal(r.confirm, undefined);
    assert.deepEqual(r.trace.lessons, []);
  });

  it("uses an approved shared write lesson", async () => {
    const agent = withLessons([{ id: "g1", phrase: "cat", canonical: "chuyen", scope: "global", approved: true }]);
    const [r] = await talk(agent, host(), ["cất Hợp đồng.docx vào Kế toán"]);
    assert.deepEqual(r.confirm?.params, { fileId: "f3", folderId: "d1" });
  });

  it("ignores lessons that redefine words it already knows", async () => {
    const agent = withLessons([{ id: "x", phrase: "tim", canonical: "chuyen", scope: "mine" }]);
    const [r] = await talk(agent, host(), ["tìm hợp đồng"]);
    assert.equal(r.trace.tools[0], "list_files");
    assert.deepEqual(r.trace.lessons, []);
  });

  it("refuses to teach a phrase made only of known words", async () => {
    const [r] = await talk(agentWith(), host(), ["Dạy: tìm => chuyển"]);
    assert.match(r.text, /đã hiểu câu này/);
  });
});

describe("agent: review regressions", () => {
  it("never rewrites e-mails or names with a lesson", async () => {
    const store = memoryStore();
    store.lessons.push({ id: "g", phrase: "gmail", canonical: "tim", scope: "mine" });
    const [r] = await talk(agentWith(store), host(), ["chia sẻ Hợp đồng.docx với bob@gmail.com quyền chỉnh sửa"]);
    assert.equal(r.confirm?.params.email, "bob@gmail.com");
    assert.deepEqual(r.trace.lessons, []);
  });

  it("applies lessons only at the start of a request (or after “rồi”)", async () => {
    const store = memoryStore();
    store.lessons.push({ id: "c", phrase: "cat", canonical: "chuyen", scope: "mine" });
    const [start, inside] = await talk(agentWith(store), host(), ["cất Hợp đồng.docx vào Kế toán", "tìm cat"]);
    assert.deepEqual(start.trace.lessons, ["c"]);
    assert.deepEqual(inside.trace.lessons, []);
  });

  it("ignores shared lessons that carry someone's names", async () => {
    const store = memoryStore();
    store.lessons.push({ id: "g", phrase: "loi", canonical: "tim hop dong", scope: "global" });
    const [r] = await talk(agentWith(store), host(), ["lôi"]);
    assert.deepEqual(r.trace.lessons, []);
  });

  it("a new request escapes a pending choice", async () => {
    const [, r] = await talk(agentWith(), host(), ["chuyển báo cáo vào Kế toán", "tóm tắt hợp đồng"]);
    assert.equal(r.trace.handledBy, "fallback");
    assert.equal(r.state.pending, null);
  });

  it("a failed pick asks again", async () => {
    const [, r] = await talk(agentWith(), host(), ["chuyển báo cáo vào Kế toán", "7"]);
    assert.match(r.text, /chọn một mục/);
  });

  it("a request the fallback recognizes escapes a pending question", async () => {
    const [, r] = await talk(agentWith(), host(), ["chuyển Hợp đồng.docx", "tóm tắt hợp đồng"]);
    assert.equal(r.trace.handledBy, "fallback");
  });

  it("does not split free text or links at “rồi”", async () => {
    const note: Tool<Ctx, R> = {
      name: "note",
      title: "",
      description: "",
      effect: "read",
      patterns: ["ghi chu {text}", "luu {url}"],
      examples: [],
      slots: { text: { multiline: true, ask: "?" }, url: { type: "url", ask: "?" } },
      async run({ args }) {
        return { type: "done", text: args.text ?? args.url };
      },
    };
    const agent = createAgent<Ctx, R>({ tools: [note, tools[0]] });
    const [a, b] = await talk(agent as never, host(), ["ghi chú gọi khách rồi gửi báo giá", "lưu https://news.vn/tin-roi-sau-do"]);
    assert.equal(a.text, "gọi khách rồi gửi báo giá");
    assert.equal(b.text, "https://news.vn/tin-roi-sau-do");
  });

  it("a tool can pass a message on to the fallback", async () => {
    const shy: Tool<Ctx, R> = {
      name: "shy",
      title: "",
      description: "",
      effect: "read",
      patterns: ["tom tat {x}"],
      examples: [],
      async run() {
        return { type: "pass" };
      },
    };
    const agent = createAgent<Ctx, R>({ tools: [shy], fallback });
    const [r] = await talk(agent as never, host(), ["tóm tắt hợp đồng"]);
    assert.equal(r.trace.handledBy, "fallback");
    assert.deepEqual(r.trace.tools, []);
  });
});

describe("agent: safety", () => {
  it("ignores tampered state", async () => {
    const agent = agentWith();
    const r = await agent.handle({ message: "1", state: { pending: { kind: "choose", tool: "move_file", slot: "file", choices: "x" }, memory: { items: [1, 2] } } }, host());
    assert.equal(r.state.pending, null);
    assert.deepEqual(r.state.memory.items, []);
  });

  it("never executes read tools or unknown tools", async () => {
    const agent = agentWith();
    assert.equal((await agent.execute("list_files", {}, host())).ok, false);
    assert.equal((await agent.execute("nope", {}, host())).ok, false);
  });

  it("every example is understood by its own tool", () => {
    const agent = agentWith();
    for (const tool of tools) for (const example of tool.examples) assert.equal(agent.understand(example)?.tool.name, tool.name, example);
  });
});
