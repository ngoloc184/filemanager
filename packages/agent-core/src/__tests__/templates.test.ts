import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compileTemplate, matchTemplate } from "../templates.ts";
import { cleanValue, fold, foldWithMap, originalSpan } from "../text.ts";

describe("fold", () => {
  it("lower-cases, removes accents and punctuation", () => {
    assert.equal(fold("  Chuyển file “Báo cáo Q3.pdf” vào ĐÂY!  "), "chuyen file bao cao q3 pdf vao day");
  });

  it("maps folded spans back to the original text", () => {
    const raw = "Đưa “Hợp đồng.docx” vào Thư mục A";
    const f = foldWithMap(raw);
    const from = f.text.indexOf("hop dong docx");
    assert.equal(originalSpan(raw, f, from, from + "hop dong docx".length), "Hợp đồng.docx");
  });

  it("cleans quotes around values", () => {
    assert.equal(cleanValue(" “Báo cáo (1).pdf”. "), "Báo cáo (1).pdf");
  });
});

describe("templates", () => {
  const move = compileTemplate("(chuyen|di chuyen|dua|them) {file} (vao|sang|toi) (thu muc|folder)? {folder}");

  it("captures slots with the user's original spelling", () => {
    const m = matchTemplate(move, "Hãy chuyển file Báo cáo Q3.pdf vào thư mục Kế toán nhé");
    assert.ok(m);
    assert.deepEqual(m.slots, { file: "file Báo cáo Q3.pdf", folder: "Kế toán" });
  });

  it("keeps a single-letter folder name that looks like a particle", () => {
    assert.equal(matchTemplate(move, "chuyển x.txt vào thư mục A")?.slots.folder, "A");
  });

  it("only matches whole messages", () => {
    assert.equal(matchTemplate(move, "tìm file nói về chuyển khoản vào tháng 9 năm ngoái"), null);
  });

  it("supports optional groups and optional slots", () => {
    const t = compileTemplate("(xem|mo) (thu muc|folder) {folder?}");
    assert.equal(matchTemplate(t, "mở thư mục")?.slots.folder, undefined);
    assert.equal(matchTemplate(t, "xem folder Dự án")?.slots.folder, "Dự án");
  });

  it("scores literal-heavy matches higher", () => {
    const a = matchTemplate(move, "chuyển a vào b");
    const b = matchTemplate(move, "chuyển một file rất dài tên là abc vào thư mục b");
    assert.ok(a && b && a.score > b.score);
  });

  it("rejects malformed templates", () => {
    assert.throws(() => compileTemplate("chuyen {file"));
    assert.throws(() => compileTemplate("{a} va {a}"));
  });
});
