import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { strToU8, zipSync } from "fflate";
import { extractText, stripMarkup } from "../assistant/extract.ts";
import { summarize, topKeywords } from "../assistant/summarize.ts";

const zip = (files: Record<string, string>) =>
  zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));

/** Smallest valid PDF with a text layer, xref offsets computed on the fly. */
function makePdf(text: string): Uint8Array {
  const stream = `BT /F1 18 Tf 50 750 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return strToU8(out);
}

describe("extractText", () => {
  it("plain text and markdown (UTF-8 with Vietnamese)", async () => {
    const r = await extractText("md", strToU8("# Hợp đồng\nĐiều khoản thanh toán"));
    assert.equal(r.status, "indexed");
    assert.ok(r.status === "indexed" && r.text.includes("Điều khoản thanh toán"));
  });

  it("html drops scripts and tags", async () => {
    const r = await extractText("html", strToU8("<h1>Title</h1><script>alert('x')</script><p>Body &amp; more</p>"));
    assert.ok(r.status === "indexed" && r.text.includes("Body & more") && !r.text.includes("alert"));
  });

  it("docx", async () => {
    const bytes = zip({
      "word/document.xml": '<w:document><w:body><w:p><w:r><w:t>API authentication</w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve">dùng JWT</w:t></w:r></w:p></w:body></w:document>',
    });
    const r = await extractText("docx", bytes);
    assert.ok(r.status === "indexed" && /API authentication\s*\n\s*dùng JWT/.test(r.text), JSON.stringify(r));
  });

  it("xlsx shared strings and sheet names", async () => {
    const bytes = zip({
      "xl/workbook.xml": '<workbook><sheets><sheet name="Doanh thu" sheetId="1"/></sheets></workbook>',
      "xl/sharedStrings.xml": "<sst><si><t>Quý 3</t></si><si><t>Tổng</t></si></sst>",
      "xl/worksheets/sheet1.xml": "<worksheet><sheetData/></worksheet>",
    });
    const r = await extractText("xlsx", bytes);
    assert.ok(r.status === "indexed" && r.text.includes("Doanh thu") && r.text.includes("Quý 3"));
  });

  it("pptx slides in order", async () => {
    const bytes = zip({
      "ppt/slides/slide2.xml": "<p:sld><a:p><a:r><a:t>Second</a:t></a:r></a:p></p:sld>",
      "ppt/slides/slide1.xml": "<p:sld><a:p><a:r><a:t>First</a:t></a:r></a:p></p:sld>",
    });
    const r = await extractText("pptx", bytes);
    assert.ok(r.status === "indexed" && r.text.indexOf("First") < r.text.indexOf("Second"));
  });

  it("pdf with a text layer", async () => {
    const r = await extractText("pdf", makePdf("Quarterly budget report"));
    assert.ok(r.status === "indexed" && r.text.includes("Quarterly budget report"), JSON.stringify(r));
  });

  it("unsupported and empty files", async () => {
    assert.equal((await extractText("png", new Uint8Array([1, 2]))).status, "unsupported");
    assert.equal((await extractText("txt", strToU8("   \n "))).status, "empty");
  });

  it("decodes entities and keeps text as data", () => {
    assert.equal(stripMarkup("<p>a &lt;b&gt; &#x1F600;</p>"), "a <b> 😀");
  });
});

describe("summarize", () => {
  const doc = [
    "Báo cáo tài chính quý 3 năm 2026 của công ty.",
    "Doanh thu quý 3 tăng 12% so với quý 2 nhờ mảng dịch vụ.",
    "Chi phí vận hành giảm 5% do tối ưu hạ tầng.",
    "Lợi nhuận quý 3 đạt mức cao nhất trong năm.",
    "Phụ lục: danh sách khách hàng mới.",
    "Thời tiết trong quý khá thuận lợi.",
    "Doanh thu dịch vụ dự kiến tiếp tục tăng trong quý 4.",
  ].join(" ");

  it("picks a few sentences in original order", () => {
    const s = summarize(doc, 3);
    assert.equal(s.points.length, 3);
    assert.equal(s.points[0], "Báo cáo tài chính quý 3 năm 2026 của công ty.");
    const positions = s.points.map((p) => doc.indexOf(p));
    assert.deepEqual([...positions].sort((a, b) => a - b), positions);
  });

  it("keywords are frequent content words", () => {
    assert.ok(topKeywords(doc).includes("doanh"));
  });

  it("handles empty text", () => {
    assert.deepEqual(summarize("").points, []);
  });
});
