// Text extraction for the search index. Runs on the server only; file bytes
// are treated as untrusted data and never executed or interpreted as markup.

import { unzipSync, strFromU8 } from "fflate";
import { MAX_INDEX_CHARS, OFFICE_EXTENSIONS, PDF_EXTENSIONS, TEXT_EXTENSIONS } from "./formats.ts";

export type Extraction =
  | { status: "indexed"; text: string; truncated: boolean }
  /** reason "needs_ocr": a PDF whose pages carry no text layer (scans). */
  | { status: "empty"; reason?: "needs_ocr" }
  | { status: "unsupported" };

/** Page separator kept in extracted PDF text (lets summaries cite pages). */
export const PAGE_BREAK = "\f";
/** Prefix of the line that starts each spreadsheet sheet in extracted text. */
export const SHEET_MARKER = "### Sheet: ";
const MAX_ROWS_PER_SHEET = 5000;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
    if (code[0] === "#") {
      const n = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : " ";
    }
    return ENTITIES[code.toLowerCase()] ?? match;
  });
}

/** Text of XML/HTML with tags removed; block-ish tags become line breaks. */
export function stripMarkup(markup: string): string {
  return decodeEntities(
    markup
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<\/(w:p|a:p|text:p|text:h|p|div|li|tr|h[1-6]|br)\s*>|<br\s*\/?>|<w:br\s*\/>|<w:tab\s*\/>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

function zipEntries(bytes: Uint8Array, filter: (name: string) => boolean): Record<string, string> {
  const files = unzipSync(bytes, { filter: (file) => filter(file.name) && file.originalSize < 50 * 1024 * 1024 });
  const out: Record<string, string> = {};
  for (const [name, data] of Object.entries(files)) out[name] = strFromU8(data);
  return out;
}

function columnIndex(ref: string): number {
  const letters = ref.replace(/\d+/g, "");
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return Math.max(n - 1, 0);
}

/** Rows of one worksheet as arrays of cell text, columns kept in place. */
function sheetRows(xml: string, shared: string[]): string[][] {
  const rows: string[][] = [];
  for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: string[] = [];
    for (const cell of row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cell[1];
      const body = cell[2] ?? "";
      const ref = attrs.match(/\br="([A-Z]+)\d+"/)?.[1];
      const type = attrs.match(/\bt="([^"]+)"/)?.[1];
      const raw = body.match(/<v>([\s\S]*?)<\/v>/)?.[1];
      let value = "";
      if (type === "s" && raw !== undefined) value = shared[Number(raw)] ?? "";
      else if (type === "inlineStr") value = stripMarkup(body);
      else if (type === "b") value = raw === "1" ? "TRUE" : "FALSE";
      else if (raw !== undefined) value = decodeEntities(raw);
      const col = ref ? columnIndex(ref) : cells.length;
      while (cells.length < col) cells.push("");
      cells[col] = value.replace(/[\t\n]+/g, " ").trim();
    }
    if (cells.some(Boolean)) rows.push(cells);
  }
  return rows;
}

function byNumber(a: string, b: string): number {
  const n = (s: string) => Number(s.match(/(\d+)\.xml$/)?.[1] ?? 0);
  return n(a) - n(b);
}

function extractOffice(extension: string, bytes: Uint8Array): string {
  switch (extension) {
    case "docx": {
      const parts = zipEntries(bytes, (n) => /^word\/(document|header\d*|footer\d*|footnotes)\.xml$/.test(n));
      const order = Object.keys(parts).sort((a) => (a === "word/document.xml" ? -1 : 1));
      return order.map((k) => stripMarkup(parts[k])).join("\n");
    }
    case "pptx": {
      const parts = zipEntries(bytes, (n) => /^ppt\/(slides\/slide|notesSlides\/notesSlide)\d+\.xml$/.test(n));
      return Object.keys(parts).sort(byNumber).map((k) => stripMarkup(parts[k])).join("\n");
    }
    case "xlsx": {
      const parts = zipEntries(bytes, (n) => n === "xl/sharedStrings.xml" || n === "xl/workbook.xml" || /^xl\/worksheets\/sheet\d+\.xml$/.test(n));
      const sheetNames = [...(parts["xl/workbook.xml"] ?? "").matchAll(/<sheet\b[^>]*\sname="([^"]*)"/g)].map((m) => decodeEntities(m[1]));
      const shared = [...(parts["xl/sharedStrings.xml"] ?? "").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
        decodeEntities([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join(""))
      );
      return Object.keys(parts)
        .filter((k) => k.startsWith("xl/worksheets/"))
        .sort(byNumber)
        .map((key, index) => {
          const rows = sheetRows(parts[key], shared).slice(0, MAX_ROWS_PER_SHEET);
          return [`${SHEET_MARKER}${sheetNames[index] ?? `Sheet${index + 1}`}`, ...rows.map((r) => r.join("\t"))].join("\n");
        })
        .join("\n\n");
    }
    case "odt":
    case "ods":
    case "odp": {
      const parts = zipEntries(bytes, (n) => n === "content.xml");
      return stripMarkup(parts["content.xml"] ?? "");
    }
    default:
      return "";
  }
}

async function extractPdf(bytes: Uint8Array): Promise<string> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(bytes);
  const { text } = await extractText(pdf, { mergePages: false });
  const pages = Array.isArray(text) ? text : [text];
  return pages.map((page) => page.trim()).join(`\n${PAGE_BREAK}\n`);
}

function decodeText(bytes: Uint8Array): string {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export async function extractText(extension: string, bytes: Uint8Array): Promise<Extraction> {
  const ext = extension.toLowerCase();
  let text: string;
  if (TEXT_EXTENSIONS.includes(ext)) {
    const raw = decodeText(bytes);
    text = ["html", "htm", "xml"].includes(ext) ? stripMarkup(raw) : raw;
    if (ext === "rtf") text = raw.replace(/\\[a-z]+-?\d* ?|[{}]/gi, " ");
  } else if (OFFICE_EXTENSIONS.includes(ext)) {
    text = extractOffice(ext, bytes);
  } else if (PDF_EXTENSIONS.includes(ext)) {
    text = await extractPdf(bytes);
  } else {
    return { status: "unsupported" };
  }

  // Drop control characters (keeps tabs, newlines and PDF page breaks).
  const clean = text.replace(/[\u0000-\u0008\u000b\u000e-\u001f\u007f]/g, " ").trim();
  if (!clean.replace(/\f/g, "").trim()) {
    return PDF_EXTENSIONS.includes(ext) ? { status: "empty", reason: "needs_ocr" } : { status: "empty" };
  }
  return {
    status: "indexed",
    text: clean.slice(0, MAX_INDEX_CHARS),
    truncated: clean.length > MAX_INDEX_CHARS,
  };
}
