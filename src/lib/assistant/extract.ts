// Text extraction for the search index. Runs on the server only; file bytes
// are treated as untrusted data and never executed or interpreted as markup.

import { unzipSync, strFromU8 } from "fflate";
import { MAX_INDEX_CHARS, OFFICE_EXTENSIONS, PDF_EXTENSIONS, TEXT_EXTENSIONS } from "./formats.ts";

export type Extraction =
  | { status: "indexed"; text: string; truncated: boolean }
  | { status: "empty" }
  | { status: "unsupported" };

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
      const sheetNames = [...(parts["xl/workbook.xml"] ?? "").matchAll(/<sheet[^>]*\sname="([^"]*)"/g)].map((m) => decodeEntities(m[1]));
      const shared = [...(parts["xl/sharedStrings.xml"] ?? "").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => stripMarkup(m[1]));
      const inline = Object.keys(parts)
        .filter((k) => k.startsWith("xl/worksheets/"))
        .sort(byNumber)
        .flatMap((k) => [...parts[k].matchAll(/<is>([\s\S]*?)<\/is>/g)].map((m) => stripMarkup(m[1])));
      return [...sheetNames, ...shared, ...inline].filter(Boolean).join("\n");
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
  const { text } = await extractText(pdf, { mergePages: true });
  return Array.isArray(text) ? text.join("\n") : text;
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

  // Drop control characters (keeps tabs/newlines) so stored text is clean.
  const clean = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").trim();
  if (!clean) return { status: "empty" };
  return {
    status: "indexed",
    text: clean.slice(0, MAX_INDEX_CHARS),
    truncated: clean.length > MAX_INDEX_CHARS,
  };
}
