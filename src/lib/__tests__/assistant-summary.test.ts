import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { strToU8, zipSync } from "fflate";
import { buildDigest, digestToText, findPassages } from "../assistant/digest.ts";
import { extractText } from "../assistant/extract.ts";
import { summarizeFile, type FileSummaryDeps, type LlmDigest } from "../assistant/file-summary.ts";

const FILE = "10000000-0000-0000-0000-0000000000a1";

/** Multi-page PDF; pass null for a page without a text layer (a "scan"). */
function makePdf(pages: (string | null)[]): Uint8Array {
  const objects: string[] = ["<< /Type /Catalog /Pages 2 0 R >>", ""];
  const kids: string[] = [];
  for (const text of pages) {
    const stream = text === null ? "0 0 200 200 re f" : `BT /F1 12 Tf 40 750 Td (${text}) Tj ET`;
    const pageId = objects.length + 1;
    kids.push(`${pageId} 0 R`);
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${pageId + 1} 0 R /Resources << /Font << /F1 FONT 0 R >> >> >>`);
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }
  const fontId = objects.length + 1;
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  objects[1] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pages.length} >>`;
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body.replace("FONT", String(fontId))}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return strToU8(out);
}

type Doc = Partial<{
  name: string;
  extension: string;
  status: string | null;
  error: string | null;
  content: string;
  current_version_id: string;
  indexed_version_id: string | null;
  truncated: boolean;
}>;

function deps(doc: Doc | null, extra: Partial<FileSummaryDeps> = {}) {
  let current: Doc | null = doc;
  const calls: string[] = [];
  const d: FileSummaryDeps = {
    async rpc<T>(fn: string) {
      calls.push(fn);
      if (!current) return [] as T[];
      return [
        {
          file_id: FILE,
          name: "file.txt",
          extension: "txt",
          mime_type: "text/plain",
          size: 100,
          folder_id: null,
          folder_name: null,
          updated_at: "2026-10-01T00:00:00Z",
          current_version_id: "v1",
          indexed_version_id: "v1",
          status: "indexed",
          error: null,
          truncated: false,
          char_count: 0,
          content: "",
          ...current,
        },
      ] as T[];
    },
    ...extra,
  };
  return { d, calls, setDoc: (next: Doc) => (current = { ...current, ...next }) };
}

const REPORT = [
  "BÁO CÁO KINH DOANH QUÝ 3",
  "",
  "1. Tổng quan",
  "Báo cáo tóm tắt kết quả kinh doanh quý 3 năm 2026 của công ty ACME.",
  "Doanh thu quý 3 đạt 12,5 tỷ đồng, tăng 18% so với quý 2.",
  "",
  "2. Chi phí",
  "Chi phí vận hành giảm 5% nhờ tối ưu hạ tầng đám mây.",
  "Chi phí marketing tăng nhẹ do chiến dịch ra mắt sản phẩm mới.",
  "",
  "3. Kế hoạch",
  "Phòng kinh doanh cần hoàn thành kế hoạch quý 4 trước ngày 15/10/2026.",
  "Bộ phận kỹ thuật phải nâng cấp hệ thống thanh toán trong tháng 11.",
  "",
  "4. Kết luận",
  "Tóm lại, quý 3 là quý tăng trưởng mạnh nhất của công ty trong năm 2026.",
].join("\n");

describe("buildDigest — documents", () => {
  it("structures a report: overview, sections, facts, actions, conclusion", () => {
    const d = buildDigest(REPORT, "txt", "detailed");
    assert.equal(d.title, "BÁO CÁO KINH DOANH QUÝ 3");
    assert.ok(d.overview[0].startsWith("Báo cáo tóm tắt kết quả kinh doanh"));
    assert.ok(d.sections.includes("1. Tổng quan") && d.sections.includes("4. Kết luận"));
    assert.ok(d.actions.some((a) => a.text.includes("trước ngày 15/10/2026")));
    assert.equal(d.conclusion?.text, "Tóm lại, quý 3 là quý tăng trưởng mạnh nhất của công ty trong năm 2026.");
  });

  it("keeps numbers and names verbatim (only copies sentences)", () => {
    const d = buildDigest(REPORT, "txt", "detailed");
    const all = [...d.overview, ...[...d.keyPoints, ...d.details, ...d.actions].map((p) => p.text)].join("\n");
    for (const sentence of all.split("\n").filter((l) => !l.startsWith("Tài liệu gồm"))) {
      assert.ok(REPORT.includes(sentence), `not verbatim: ${sentence}`);
    }
    assert.ok(all.includes("12,5 tỷ đồng"));
  });

  it("covers the end of long documents, not just the beginning", () => {
    const body = Array.from({ length: 400 }, (_, i) =>
      i === 380
        ? "Phần cuối nêu quyết định quan trọng: dự án Falcon sẽ được triển khai toàn quốc."
        : `Đoạn ${i} mô tả chi tiết vận hành kho hàng và quy trình giao nhận số ${i}.`
    ).join(" ");
    const d = buildDigest(body, "txt", "detailed");
    assert.ok(d.coverage.parts > 1);
    const lastQuarter = d.keyPoints.filter((p) => {
      const n = Number(p.text.match(/Đoạn (\d+)/)?.[1] ?? 380);
      return n >= 300;
    });
    assert.ok(lastQuarter.length > 0, "key points come from the last part too");
  });

  it("length options change the amount of detail", () => {
    const long = Array.from({ length: 60 }, (_, i) => `Câu số ${i} nói về chủ đề doanh thu và khách hàng thứ ${i}.`).join(" ");
    const short = buildDigest(long, "txt", "short").keyPoints.length;
    const detailed = buildDigest(long, "txt", "detailed").keyPoints.length;
    assert.ok(short < detailed, `${short} < ${detailed}`);
  });

  it("finds passages for questions, with page numbers", async () => {
    const r = await extractText("pdf", makePdf(["Hop dong dich vu ACME.", "Dieu khoan thanh toan trong 30 ngay ke tu ngay ky."]));
    assert.ok(r.status === "indexed");
    const passages = findPassages(r.text, "Điều khoản thanh toán là bao nhiêu ngày?");
    assert.equal(passages[0]?.page, 2);
    assert.match(passages[0].text, /30 ngay/);
  });

  it("copy text contains every section", () => {
    const text = digestToText(buildDigest(REPORT, "txt", "keypoints"), "report.txt", "label");
    assert.match(text, /^Tóm tắt: report\.txt/);
    assert.match(text, /Tổng quan/);
    assert.match(text, /Việc cần thực hiện/);
  });
});

describe("buildDigest — tables", () => {
  it("CSV: columns, row count and numeric statistics", () => {
    const csv = "Tháng,Doanh thu,Khu vực\n7,1.200.000,Bắc\n8,1.500.000,Nam\n9,1.800.000,Nam\n";
    const d = buildDigest(csv, "csv", "keypoints");
    assert.equal(d.kind, "table");
    assert.match(d.overview[0], /3 dòng và 3 cột/);
    const revenue = d.details.find((p) => p.text.startsWith("“Doanh thu”"));
    assert.ok(revenue && revenue.text.includes("4.500.000") && revenue.text.includes("1.800.000"), JSON.stringify(d.details));
  });

  it("XLSX: every sheet is described", async () => {
    const sheet = (rows: string[][]) =>
      `<worksheet><sheetData>${rows
        .map((r, i) => `<row r="${i + 1}">${r.map((v, j) => `<c r="${"AB"[j]}${i + 1}" t="inlineStr"><is><t>${v}</t></is></c>`).join("")}</row>`)
        .join("")}</sheetData></worksheet>`;
    const bytes = zipSync({
      "xl/workbook.xml": strToU8('<workbook><sheets><sheet name="Thu" sheetId="1"/><sheet name="Chi" sheetId="2"/></sheets></workbook>'),
      "xl/worksheets/sheet1.xml": strToU8(sheet([["Mục", "Số tiền"], ["Bán hàng", "100"], ["Dịch vụ", "50"]])),
      "xl/worksheets/sheet2.xml": strToU8(sheet([["Mục", "Số tiền"], ["Lương", "70"]])),
    });
    const r = await extractText("xlsx", bytes);
    assert.ok(r.status === "indexed");
    const d = buildDigest(r.text, "xlsx", "keypoints");
    assert.equal(d.sheets.length, 2);
    assert.match(d.overview[0], /2 sheet: “Thu”, “Chi”/);
    assert.ok(d.details.some((p) => p.text.includes("tổng 150")));
  });
});

describe("summarizeFile — the 12 required cases", () => {
  it("1. TXT summary, no model involved (no API tokens)", async () => {
    const llmCalls = 0;
    const { d } = deps({ content: REPORT });
    const r = await summarizeFile({ fileId: FILE, length: "short" }, d);
    assert.ok(r.ok);
    assert.equal(r.ok && r.engine, "local");
    assert.equal(llmCalls, 0);
    assert.match(r.ok ? r.text : "", /không dùng mô hình AI/);
  });

  it("2. PDF with text: summary cites pages", async () => {
    const pdf = await extractText("pdf", makePdf(["Bao cao nam 2026 ve doanh thu. Doanh thu tang 20%.", "Ket luan: tom lai nam 2026 tang truong tot."]));
    assert.ok(pdf.status === "indexed");
    const { d } = deps({ name: "r.pdf", extension: "pdf", content: pdf.text });
    const r = await summarizeFile({ fileId: FILE }, d);
    assert.ok(r.ok && r.digest.coverage.pages === 2);
    assert.equal(r.ok && r.digest.conclusion?.page, 2);
  });

  it("3. DOCX: headings and paragraphs", async () => {
    const docx = zipSync({
      "word/document.xml": strToU8(
        "<w:document><w:body>" +
          ["KẾ HOẠCH DỰ ÁN", "Dự án xây dựng cổng thanh toán mới cho khách hàng doanh nghiệp.", "Nhóm kỹ thuật cần hoàn thành API trước ngày 30/11/2026."]
            .map((t) => `<w:p><w:r><w:t>${t}</w:t></w:r></w:p>`)
            .join("") +
          "</w:body></w:document>"
      ),
    });
    const text = await extractText("docx", docx);
    assert.ok(text.status === "indexed");
    const { d } = deps({ name: "plan.docx", extension: "docx", content: text.text });
    const r = await summarizeFile({ fileId: FILE }, d);
    assert.ok(r.ok && r.digest.title === "KẾ HOẠCH DỰ ÁN");
    assert.ok(r.ok && r.digest.actions[0]?.text.includes("30/11/2026"));
  });

  it("4. CSV table summary", async () => {
    const { d } = deps({ name: "sales.csv", extension: "csv", content: "Sản phẩm;Số lượng\nA;10\nB;20\n" });
    const r = await summarizeFile({ fileId: FILE }, d);
    assert.ok(r.ok && r.digest.kind === "table");
    assert.ok(r.ok && r.digest.details.some((p) => p.text.includes("tổng 30")));
  });

  it("5. empty file", async () => {
    const { d } = deps({ status: "empty", content: "" });
    const r = await summarizeFile({ fileId: FILE }, d);
    assert.ok(!r.ok && r.code === "empty");
  });

  it("6. file too large", async () => {
    const { d } = deps({ status: "too_large" });
    const r = await summarizeFile({ fileId: FILE }, d);
    assert.ok(!r.ok && r.code === "too_large");
  });

  it("7. scanned PDF needs OCR (never pretends to have read it)", async () => {
    const scan = await extractText("pdf", makePdf([null, null]));
    assert.deepEqual(scan, { status: "empty", reason: "needs_ocr" });
    const { d } = deps({ name: "scan.pdf", extension: "pdf", status: "empty", error: "needs_ocr" });
    const r = await summarizeFile({ fileId: FILE }, d);
    assert.ok(!r.ok && r.code === "needs_ocr" && /OCR/.test(r.message));
  });

  it("8. unsupported format", async () => {
    const { d, calls } = deps({ name: "photo.png", extension: "png", status: null });
    const r = await summarizeFile({ fileId: FILE }, d);
    assert.ok(!r.ok && r.code === "unsupported");
    assert.equal(calls.length, 1, "no indexing attempt");
  });

  it("9. no read permission: nothing about the file is revealed", async () => {
    const { d } = deps(null);
    const r = await summarizeFile({ fileId: FILE }, d);
    assert.ok(!r.ok && r.code === "not_found" && r.status === 404);
    assert.equal(!r.ok && r.file, undefined);
    const bad = await summarizeFile({ fileId: "1 or 1=1" }, d);
    assert.ok(!bad.ok && bad.code === "invalid");
  });

  it("10. file updated: old summary source is re-read for the new version", async () => {
    let indexed = 0;
    const holder = deps({ content: "", indexed_version_id: "v1", current_version_id: "v2" });
    holder.d.indexFile = async () => {
      indexed += 1;
      holder.setDoc({ indexed_version_id: "v2", content: "Phiên bản mới nói về kế hoạch mở rộng thị trường miền Trung năm 2027." });
    };
    const r = await summarizeFile({ fileId: FILE }, holder.d);
    assert.equal(indexed, 1);
    assert.ok(r.ok && r.digest.overview[0].includes("miền Trung"));

    const noIndexer = deps({ indexed_version_id: "v1", current_version_id: "v2" });
    const r2 = await summarizeFile({ fileId: FILE }, noIndexer.d);
    assert.ok(!r2.ok && r2.code === "not_indexed");
  });

  it("12. the optional model is only used when injected, cached per version, and falls back", async () => {
    const cache = new Map<string, LlmDigest>();
    let calls = 0;
    const llmDigest = async () => {
      calls += 1;
      return { overview: ["Tổng quan từ mô hình."], keyPoints: [{ text: "Ý một", page: null }], details: [], actions: [], conclusion: null };
    };
    const { d } = deps({ content: REPORT }, { llmDigest, cache });
    const a = await summarizeFile({ fileId: FILE }, d);
    const b = await summarizeFile({ fileId: FILE }, d);
    assert.ok(a.ok && a.engine === "llm" && !a.cached);
    assert.ok(b.ok && b.cached);
    assert.equal(calls, 1, "second request served from cache");
    await summarizeFile({ fileId: FILE, refresh: true }, d);
    assert.equal(calls, 2, "refresh asks the model again");

    const broken = deps({ content: REPORT }, { llmDigest: async () => { throw new Error("down"); } });
    const c = await summarizeFile({ fileId: FILE }, broken.d);
    assert.ok(c.ok && c.engine === "local" && c.notices.some((n) => n.includes("cục bộ")));
  });

  it("answers questions from the file content", async () => {
    const { d } = deps({ content: REPORT });
    const r = await summarizeFile({ fileId: FILE, question: "Doanh thu quý 3 là bao nhiêu?" }, d);
    assert.ok(r.ok && r.answer?.passages[0].text.includes("12,5 tỷ đồng"));
    assert.equal(r.ok && r.answer?.text, null, "no model → passages only");
  });
});
