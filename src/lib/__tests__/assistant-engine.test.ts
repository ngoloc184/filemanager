import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { answer, openUrl, type AssistantDeps, type AssistantRpc } from "../assistant/engine.ts";

type Call = { fn: AssistantRpc; args: Record<string, unknown> };

const NOW = new Date("2026-10-12T03:00:00Z");
const FILE_A = "10000000-0000-0000-0000-0000000000a1";

function row(overrides: Record<string, unknown> = {}) {
  return {
    file_id: FILE_A,
    name: "bao-cao-tai-chinh-thang-9.pdf",
    extension: "pdf",
    mime_type: "application/pdf",
    size: 1000,
    folder_id: "f0000000-0000-0000-0000-0000000000a1",
    folder_name: "Hợp đồng",
    access: "owner",
    owner_email: "alice@example.com",
    updated_at: "2026-10-01T02:00:00Z",
    total_count: 1,
    ...overrides,
  };
}

function fakeDeps(responses: Partial<Record<AssistantRpc, unknown[]>> = {}, extra: Partial<AssistantDeps> = {}) {
  const calls: Call[] = [];
  const deps: AssistantDeps = {
    now: NOW,
    async rpc<T>(fn: AssistantRpc, args: Record<string, unknown>) {
      calls.push({ fn, args });
      return (responses[fn] ?? []) as T[];
    },
    ...extra,
  };
  return { deps, calls };
}

describe("assistant engine", () => {
  it("greets without touching the database or any model", async () => {
    const { deps, calls } = fakeDeps();
    const r = await answer({ message: "Xin chào" }, deps);
    assert.equal(r.intent, "greeting");
    assert.equal(r.engine, "local");
    assert.equal(calls.length, 0);
    assert.ok(r.suggestions?.length);
  });

  it("name search uses the predefined function with parsed parameters", async () => {
    const { deps, calls } = fakeDeps({ assistant_find_files: [row()] });
    const r = await answer({ message: "Liệt kê các file PDF tôi mới tải lên" }, deps);
    assert.equal(calls[0].fn, "assistant_find_files");
    assert.deepEqual(calls[0].args.p_extensions, ["pdf"]);
    assert.equal(calls[0].args.p_scope, "mine");
    assert.equal(calls[0].args.p_sort, "created");
    assert.equal(r.files?.[0].openUrl, `/dashboard?folder=f0000000-0000-0000-0000-0000000000a1&file=${FILE_A}`);
    assert.equal(r.files?.[0].sharedBy, null, "owner e-mail only shown for shared files");
    assert.equal(r.engine, "local");
  });

  it("content search indexes pending files first and keeps snippets", async () => {
    let indexedCalls = 0;
    const { deps, calls } = fakeDeps(
      { assistant_search_content: [row({ snippet: "… API authentication với JWT …" })] },
      {
        indexPending: async () => {
          indexedCalls += 1;
          return { indexed: 3, remaining: 5 };
        },
      }
    );
    const r = await answer({ message: "Tìm tài liệu có nội dung nhắc đến API authentication" }, deps);
    assert.equal(indexedCalls, 1);
    assert.deepEqual(calls.map((c) => c.fn), ["assistant_search_content"]);
    assert.equal(calls[0].args.p_query, "api authentication");
    assert.equal(r.files?.[0].snippet, "… API authentication với JWT …");
    assert.ok(r.notices?.[0].includes("5 file chưa được lập chỉ mục"));
  });

  it("topic questions merge name and content hits without duplicates", async () => {
    const { deps } = fakeDeps({
      assistant_find_files: [row()],
      assistant_search_content: [row({ snippet: "hợp đồng dịch vụ" }), row({ file_id: "10000000-0000-0000-0000-0000000000a9", name: "khac.docx", snippet: "x" })],
    });
    const r = await answer({ message: "file nào liên quan đến hợp đồng" }, deps);
    assert.equal(r.files?.length, 2);
    assert.equal(r.files?.[0].snippet, "hợp đồng dịch vụ");
  });

  it("no results: clear message and alternative suggestions", async () => {
    const { deps } = fakeDeps();
    const r = await answer({ message: "Tìm file báo cáo tài chính tháng 9" }, deps);
    assert.equal(r.files?.length, 0);
    assert.match(r.text, /không tìm thấy/i);
    assert.ok(r.suggestions?.some((s) => s.includes("nội dung")));
  });

  it("unrelated questions with no results are out of scope", async () => {
    const { deps } = fakeDeps();
    const r = await answer({ message: "thời tiết hôm nay thế nào" }, deps);
    assert.equal(r.intent, "out_of_scope");
  });

  it("summary of an inaccessible file reveals nothing", async () => {
    const { deps } = fakeDeps({ assistant_get_content: [] });
    const r = await answer({ message: "Tóm tắt file này", contextFileId: FILE_A }, deps);
    assert.doesNotMatch(r.text, /bao-cao/);
    assert.match(r.text, /không tìm thấy/i);
  });

  it("local extractive summary by default (no model)", async () => {
    const content =
      "Báo cáo tài chính quý 3 của công ty. Doanh thu quý 3 tăng mạnh nhờ dịch vụ mới. " +
      "Chi phí giảm nhẹ. Doanh thu dịch vụ dự kiến tăng tiếp. Lợi nhuận đạt kỷ lục quý 3. Phụ lục khách hàng.";
    const { deps } = fakeDeps({
      assistant_get_content: [{ ...row(), status: "indexed", content, is_current: true }],
    });
    const r = await answer({ message: "Tóm tắt file này", contextFileId: FILE_A }, deps);
    assert.equal(r.engine, "local");
    assert.ok(r.summary && r.summary.points.length > 0);
    assert.match(r.text, /không dùng AI/);
  });

  it("uses the optional model only when injected, and falls back on failure", async () => {
    const content = "Nội dung đủ dài để tóm tắt. Câu thứ hai cũng đủ dài để tính. Câu thứ ba có thêm ý.";
    const base = { assistant_get_content: [{ ...row(), status: "indexed", content, is_current: true }] };

    const ok = fakeDeps(base, { summarizeWithLlm: async () => ["Ý một", "Ý hai"] });
    const r1 = await answer({ message: "Tóm tắt file này", contextFileId: FILE_A }, ok.deps);
    assert.equal(r1.engine, "llm");
    assert.deepEqual(r1.summary?.points, ["Ý một", "Ý hai"]);

    const broken = fakeDeps(base, {
      summarizeWithLlm: async () => {
        throw new Error("down");
      },
    });
    const r2 = await answer({ message: "Tóm tắt file này", contextFileId: FILE_A }, broken.deps);
    assert.equal(r2.engine, "local");
    assert.ok(r2.notices?.[0].includes("tóm tắt cục bộ"));
  });

  it("unsupported formats are explained", async () => {
    const { deps } = fakeDeps({
      assistant_get_content: [{ ...row({ extension: "png", name: "a.png" }), status: null, content: "", is_current: null }],
    });
    const r = await answer({ message: "Tóm tắt file này", contextFileId: FILE_A }, deps);
    assert.match(r.text, /chưa được hỗ trợ/);
  });

  it("ignores malformed context ids and clamps pages", async () => {
    const { deps, calls } = fakeDeps({ assistant_find_files: [] });
    const r = await answer({ message: "Tóm tắt file này", contextFileId: "1 or 1=1" }, deps);
    assert.match(r.text, /muốn tóm tắt file nào/);
    assert.equal(calls.length, 0);
    await answer({ message: "file pdf", page: 9999 }, deps);
    assert.equal(calls.at(-1)?.args.p_offset, 49 * 8);
  });

  it("lists what the user shared with someone", async () => {
    const { deps, calls } = fakeDeps({
      assistant_my_shares: [
        { item_type: "folder", item_id: "f1", name: "Hợp đồng", folder_id: null, grantee_email: "nguyenvana@example.com", role: "viewer", shared_at: "2026-10-01T00:00:00Z", total_count: 1 },
      ],
    });
    const r = await answer({ message: "Tôi đã chia sẻ những file nào với Nguyễn Văn A?" }, deps);
    assert.equal(calls[0].args.p_grantee, "Nguyễn Văn A");
    assert.equal(r.shares?.[0].openUrl, "/dashboard?folder=f1");
  });

  it("stats", async () => {
    const { deps } = fakeDeps({
      assistant_file_stats: [{ owned_files: 12, owned_bytes: 2048, owned_folders: 3, shared_files: 4, public_files: 1, indexable_files: 10, indexed_files: 7, last_upload: "2026-10-10T00:00:00Z", top_extensions: [{ extension: "pdf", count: 5 }] }],
    });
    const r = await answer({ message: "Thống kê file của tôi" }, deps);
    assert.equal(r.stats?.ownedFiles, 12);
    assert.match(r.text, /12 file/);
    assert.ok(r.notices?.[0].includes("3 file"));
  });

  it("openUrl encodes ids safely", () => {
    assert.equal(openUrl("x&y", null), "/dashboard?file=x%26y");
  });
});

import { createRateLimiter } from "../assistant/rate-limit.ts";

describe("rate limiter", () => {
  it("limits per user within the window", () => {
    const allow = createRateLimiter(2, 1000);
    assert.equal(allow("a", 0), true);
    assert.equal(allow("a", 10), true);
    assert.equal(allow("a", 20), false);
    assert.equal(allow("b", 20), true, "users are limited independently");
    assert.equal(allow("a", 1500), true, "window slides");
  });
});
