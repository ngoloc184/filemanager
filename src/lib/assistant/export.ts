// Builds the files the assistant can create: CSV, Excel (.xlsx), Markdown
// and plain text (framework-free; no external service).

import { strToU8, zipSync } from "fflate";

export type ExportFormat = "xlsx" | "csv" | "md" | "txt";
export type ExportTable = { title: string; columns: string[]; rows: string[][] };
export type ExportDocument = { title: string; table?: ExportTable; sections?: { heading: string; lines: string[] }[] };

export const EXPORT_MIME: Record<ExportFormat, string> = {
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv",
  md: "text/markdown",
  txt: "text/plain",
};

const MAX_ROWS = 5000;

// Formula-looking cells are prefixed so spreadsheet apps never execute them.
const safeCell = (v: string) => (/^[=+\-@\t\r]/.test(v) ? `'${v}` : v);

export function toCsv(table: ExportTable): Uint8Array {
  const esc = (v: string) => {
    const s = safeCell(v ?? "");
    return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [table.columns, ...table.rows.slice(0, MAX_ROWS)].map((r) => r.map(esc).join(","));
  // BOM so Excel opens UTF-8 (Vietnamese) correctly
  return strToU8(`﻿${lines.join("\r\n")}\r\n`);
}

const xml = (s: string) =>
  s
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

function colName(i: number): string {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/** Minimal valid Office Open XML workbook with one sheet. */
export function toXlsx(table: ExportTable, sheetName = "Sheet1"): Uint8Array {
  const rows = [table.columns, ...table.rows.slice(0, MAX_ROWS)];
  const widths = table.columns.map((_, c) =>
    Math.min(60, Math.max(10, ...rows.map((r) => (r[c] ?? "").length + 2)))
  );
  const sheetRows = rows
    .map((r, ri) => {
      const cells = r
        .map((v, ci) => {
          const ref = `${colName(ci)}${ri + 1}`;
          const style = ri === 0 ? ' s="1"' : "";
          if (ri > 0 && /^-?\d+(\.\d+)?$/.test(v) && v.length < 16) return `<c r="${ref}"${style}><v>${v}</v></c>`;
          return `<c r="${ref}" t="inlineStr"${style}><is><t xml:space="preserve">${xml(safeCell(v ?? ""))}</t></is></c>`;
        })
        .join("");
      return `<row r="${ri + 1}">${cells}</row>`;
    })
    .join("");
  const name = xml(sheetName.replace(/[\\/?*[\]:]/g, " ").slice(0, 31) || "Sheet1");
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>'
    ),
    "_rels/.rels": strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'
    ),
    "xl/workbook.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${name}" sheetId="1" r:id="rId1"/></sheets></workbook>`
    ),
    "xl/_rels/workbook.xml.rels": strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'
    ),
    "xl/styles.xml": strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs></styleSheet>'
    ),
    "xl/worksheets/sheet1.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${widths
        .map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`)
        .join("")}</cols><sheetData>${sheetRows}</sheetData></worksheet>`
    ),
  };
  return zipSync(files, { level: 6 });
}

function toLines(doc: ExportDocument, markdown: boolean): string[] {
  const out: string[] = [markdown ? `# ${doc.title}` : doc.title, ""];
  if (doc.table) {
    const { columns, rows } = doc.table;
    if (markdown) {
      const cell = (v: string) => (v ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
      out.push(`| ${columns.map(cell).join(" | ")} |`, `| ${columns.map(() => "---").join(" | ")} |`);
      for (const r of rows.slice(0, MAX_ROWS)) out.push(`| ${r.map(cell).join(" | ")} |`);
    } else {
      for (const r of [columns, ...rows.slice(0, MAX_ROWS)]) out.push(r.join("\t"));
    }
    out.push("");
  }
  for (const s of doc.sections ?? []) {
    if (!s.lines.length) continue;
    out.push(markdown ? `## ${s.heading}` : s.heading, ...s.lines.map((l) => `- ${l}`), "");
  }
  return out;
}

export function buildExport(doc: ExportDocument, format: ExportFormat): Uint8Array {
  switch (format) {
    case "xlsx":
      return toXlsx(doc.table ?? { title: doc.title, columns: ["Nội dung"], rows: (doc.sections ?? []).flatMap((s) => [[s.heading], ...s.lines.map((l) => [l])]) }, doc.title);
    case "csv":
      return toCsv(doc.table ?? { title: doc.title, columns: ["Mục", "Nội dung"], rows: (doc.sections ?? []).flatMap((s) => s.lines.map((l) => [s.heading, l])) });
    case "md":
      return strToU8(toLines(doc, true).join("\n"));
    default:
      return strToU8(toLines(doc, false).join("\n"));
  }
}

/** Safe file name for an export ("So sánh hợp đồng.xlsx"). */
export function exportFileName(title: string, format: ExportFormat, now: Date = new Date()): string {
  const base = title
    .replace(/[\\/:*?"<>|\u0000-\u001F]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "Kết quả trợ lý";
  const stamp = now.toISOString().slice(0, 10);
  return `${base} ${stamp}.${format}`;
}
