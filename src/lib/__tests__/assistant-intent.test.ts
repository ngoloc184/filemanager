import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mentionsFiles, parseQuestion, type Intent } from "../assistant/intent.ts";
import { normalize } from "../assistant/text.ts";

// Fixed clock: 12 Oct 2026, 10:00 in Vietnam (UTC+7).
const NOW = new Date("2026-10-12T03:00:00Z");
const parse = (q: string) => parseQuestion(q, { now: NOW });

function find(q: string) {
  const intent = parse(q);
  assert.equal(intent.kind, "find", `${q} -> ${JSON.stringify(intent)}`);
  return intent as Extract<Intent, { kind: "find" }>;
}

describe("normalize", () => {
  it("removes Vietnamese diacritics including đ", () => {
    assert.equal(normalize("Hợp Đồng Báo Cáo Tài Chính"), "hop dong bao cao tai chinh");
  });
});

describe("parseQuestion — example questions from the brief", () => {
  it("Tìm giúp tôi file báo cáo tài chính tháng 9.", () => {
    const i = find("Tìm giúp tôi file báo cáo tài chính tháng 9.");
    assert.deepEqual(i.terms, ["bao", "cao", "tai", "chinh", "thang", "9"]);
    assert.equal(i.filters.after, null, "a bare month in a name search is a soft term, not a filter");
  });

  it("Tôi có những file nào liên quan đến hợp đồng?", () => {
    const i = find("Tôi có những file nào liên quan đến hợp đồng?");
    assert.deepEqual(i.terms, ["hop", "dong"]);
    assert.equal(i.mode, "auto");
  });

  it("Liệt kê các file PDF tôi mới tải lên.", () => {
    const i = find("Liệt kê các file PDF tôi mới tải lên.");
    assert.deepEqual(i.filters.extensions, ["pdf"]);
    assert.equal(i.sort, "created");
    assert.equal(i.filters.scope, "mine");
    assert.deepEqual(i.terms, []);
  });

  it("Tìm tài liệu có nội dung nhắc đến API authentication.", () => {
    const i = find("Tìm tài liệu có nội dung nhắc đến API authentication.");
    assert.equal(i.mode, "content");
    assert.equal(i.filters.extensions, null, "'nhắc đến' is not 'nhạc' (music)");
    assert.equal(i.phrase, "api authentication");
  });

  it("Trong các file tôi được chia sẻ, có tài liệu nào về database không?", () => {
    const i = find("Trong các file tôi được chia sẻ, có tài liệu nào về database không?");
    assert.equal(i.filters.scope, "shared");
    assert.deepEqual(i.terms, ["database"]);
    assert.equal(i.mode, "auto");
  });

  it("File nào được cập nhật gần đây nhất?", () => {
    const i = find("File nào được cập nhật gần đây nhất?");
    assert.equal(i.sort, "updated");
    assert.equal(i.single, true);
    assert.deepEqual(i.terms, []);
  });

  it("Tóm tắt thông tin chính trong file này.", () => {
    assert.deepEqual(parse("Tóm tắt thông tin chính trong file này."), {
      kind: "summarize",
      terms: [],
      useContext: true,
    });
  });

  it("Tìm những tài liệu có nội dung tương tự nhau.", () => {
    const i = parse("Tìm những tài liệu có nội dung tương tự nhau.");
    assert.equal(i.kind, "similar");
  });

  it("Tôi đã chia sẻ những file nào với Nguyễn Văn A?", () => {
    assert.deepEqual(parse("Tôi đã chia sẻ những file nào với Nguyễn Văn A?"), {
      kind: "my_shares",
      grantee: "Nguyễn Văn A",
    });
  });

  it("Tìm các tài liệu có nhắc đến \"điều khoản thanh toán\".", () => {
    const i = find('Tìm các tài liệu có nhắc đến "điều khoản thanh toán".');
    assert.equal(i.mode, "content");
    assert.equal(i.phrase, '"dieu khoan thanh toan"');
  });
});

describe("parseQuestion — other cases", () => {
  it("summarize a named file", () => {
    assert.deepEqual(parse("Tóm tắt file hop-dong-acme.docx"), {
      kind: "summarize",
      terms: ["hop", "dong", "acme", "docx"],
      useContext: false,
    });
  });

  it("date phrases with an upload verb become filters", () => {
    const i = find("Những file tôi tải lên tháng 9");
    assert.equal(i.filters.dateLabel, "tháng 9/2026");
    assert.equal(i.filters.dateField, "created");
    assert.equal(i.filters.after?.toISOString(), "2026-08-31T17:00:00.000Z");
    assert.equal(i.filters.before?.toISOString(), "2026-09-30T17:00:00.000Z");
  });

  it("a future month means last year", () => {
    const i = find("ảnh tải lên tháng 12");
    assert.equal(i.filters.dateLabel, "tháng 12/2025");
    assert.ok(i.filters.extensions?.includes("png"));
  });

  it("relative dates", () => {
    assert.equal(find("file cập nhật hôm qua").filters.dateLabel, "hôm qua");
    assert.equal(find("pdf trong 7 ngày qua").filters.dateLabel, "7 ngày qua");
    assert.equal(find("files uploaded this week").filters.dateLabel, "tuần này");
  });

  it("stats, greeting, help", () => {
    assert.equal(parse("Thống kê file của tôi").kind, "stats");
    assert.equal(parse("Tôi có bao nhiêu file?").kind, "stats");
    assert.equal(parse("Xin chào").kind, "greeting");
    assert.equal(parse("Bạn làm được gì?").kind, "help");
  });

  it("music is still recognised with context", () => {
    assert.ok(find("tìm file nhạc mp3").filters.extensions?.includes("mp3"));
    assert.ok(find("các bài hát tải lên tuần này").filters.extensions?.includes("mp3"));
  });

  it("'anh' as a pronoun is not an image filter", () => {
    const i = find("anh tìm giúp em file kế hoạch");
    assert.equal(i.filters.extensions, null);
  });

  it("shared with me is not 'what I shared'", () => {
    const i = find("file được chia sẻ với tôi");
    assert.equal(i.filters.scope, "shared");
  });

  it("vague and out-of-scope questions", () => {
    assert.equal(parse("Tìm file").kind, "clarify");
    assert.equal(parse("thế nào").kind, "out_of_scope");
    // has words but nothing file-related: the engine answers out-of-scope
    // when the permission-scoped search finds nothing
    assert.equal(mentionsFiles("thời tiết hôm nay thế nào"), false);
    assert.equal(parse("   ").kind, "clarify");
  });

  it("english queries", () => {
    const i = find("find pdf documents about budget");
    assert.deepEqual(i.terms, ["budget"]);
    assert.deepEqual(i.filters.extensions, ["pdf"]);
  });

  it("caps question length and never throws on odd input", () => {
    assert.doesNotThrow(() => parse("%".repeat(10_000)));
    assert.doesNotThrow(() => parse("'; drop table files; --"));
    const i = parse("'; drop table files; --");
    assert.ok(i.kind === "find" || i.kind === "clarify" || i.kind === "out_of_scope");
  });
});
