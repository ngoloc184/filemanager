// Structured, extractive summaries computed locally (no AI, no network).
// Every point is a sentence copied verbatim from the document, so numbers,
// dates and names are never altered. Long documents are split into parts and
// every part contributes, so the end of a document is never ignored.

import { normalize, tokenize } from "./text.ts";
import { PAGE_BREAK, SHEET_MARKER } from "./extract.ts";

export type SummaryLength = "short" | "keypoints" | "detailed";

export type Passage = { text: string; page: number | null };

export type ColumnDigest = {
  name: string;
  kind: "number" | "text";
  filled: number;
  /** numeric columns */
  sum?: number;
  min?: number;
  max?: number;
  avg?: number;
  /** text columns */
  distinct?: number;
  top?: string[];
};

export type SheetDigest = {
  name: string;
  rows: number;
  columns: ColumnDigest[];
  sample: string[][];
};

export type Digest = {
  kind: "document" | "table";
  title: string | null;
  overview: string[];
  sections: string[];
  keyPoints: Passage[];
  details: Passage[];
  actions: Passage[];
  conclusion: Passage | null;
  sheets: SheetDigest[];
  keywords: string[];
  coverage: { chars: number; sentences: number; parts: number; pages: number | null };
};

const TARGETS: Record<SummaryLength, { key: number; details: number; actions: number }> = {
  short: { key: 3, details: 2, actions: 3 },
  keypoints: { key: 6, details: 4, actions: 5 },
  detailed: { key: 10, details: 8, actions: 8 },
};

const STOPWORDS = new Set(
  (
    "va la cua cac co cho voi nhung mot trong khi da duoc nay do de ve tu den thi ma neu cung nhu vao " +
    "ra theo tai tren duoi sau truoc hon rat nhieu it khong chua se dang bi nguoi viec phai can nen hay " +
    "hoac boi vi the nao gi ai dau sao thang nam ngay tuan gio muc dat nho so cao thap tang giam moi cu " +
    "the a an and or of to in on for with is are was were be been this that these those it its as at by " +
    "from has have had not but if then than so such can will would should may also into our we you they"
  ).split(" ")
);

const NUMERIC_FACT =
  /(\d+([.,]\d+)?\s*(%|phan tram|vnd|vnđ|đ|dong|trieu|ty|nghin|usd|\$|eur|kg|km|m2|nguoi|percent|million|billion))|(\b\d{1,2}[/-]\d{1,2}([/-]\d{2,4})?\b)|(\b(19|20)\d{2}\b)|(\b(quy|thang|q)\s?\d)/i;
const ACTION =
  /\b(can phai|can|phai|de nghi|yeu cau|han chot|han nop|deadline|truoc ngay|chiu trach nhiem|giao cho|nhiem vu|ke hoach|du kien|se thuc hien|todo|action item|must|should|need to|required|due|next steps?|buoc tiep theo)\b/;
const CONCLUSION = /\b(ket luan|tom lai|nhin chung|tong ket|tong quan lai|in conclusion|overall|to sum up|in summary)\b/;

type Sentence = { text: string; page: number | null; index: number; paragraphStart: boolean; words: string[] };

function contentWords(text: string): string[] {
  return tokenize(normalize(text)).filter((w) => w.length > 2 && !STOPWORDS.has(w) && !/^\d+$/.test(w));
}

function isHeading(line: string): boolean {
  const t = line.trim();
  if (t.length < 3 || t.length > 90) return false;
  if (/^#{1,6}\s+\S/.test(t)) return true;
  if (/[.!?;:,]$/.test(t)) return false;
  if (/^((\d+(\.\d+)*)|[IVXLC]+|[A-Z])[.)]\s+\S/.test(t)) return true;
  const letters = t.replace(/[^\p{L}]/gu, "");
  return letters.length >= 3 && letters === letters.toUpperCase() && letters !== letters.toLowerCase();
}

function cleanHeading(line: string): string {
  return line.replace(/^#{1,6}\s+/, "").trim();
}

function splitIntoSentences(paragraph: string): string[] {
  return paragraph
    .split(/(?<=[.!?。…])\s+(?=[\p{Lu}\d"“(])/u)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s.length >= 12 && s.length <= 700 && /\p{L}/u.test(s));
}

function parseDocument(content: string) {
  const pages = content.split(PAGE_BREAK);
  const hasPages = pages.length > 1;
  const sentences: Sentence[] = [];
  const headings: string[] = [];
  let title: string | null = null;

  pages.forEach((pageText, pageIndex) => {
    const page = hasPages ? pageIndex + 1 : null;
    let paragraph: string[] = [];
    const flush = () => {
      if (!paragraph.length) return;
      splitIntoSentences(paragraph.join(" ")).forEach((text, i) => {
        sentences.push({ text, page, index: sentences.length, paragraphStart: i === 0, words: contentWords(text) });
      });
      paragraph = [];
    };
    for (const raw of pageText.split("\n")) {
      const line = raw.trim();
      if (!line) {
        flush();
        continue;
      }
      if (isHeading(line)) {
        flush();
        const heading = cleanHeading(line);
        if (!title) title = heading;
        else if (headings.length < 20 && !headings.includes(heading)) headings.push(heading);
        continue;
      }
      paragraph.push(line);
    }
    flush();
  });
  return { sentences, headings, title, pages: hasPages ? pages.length : null };
}

/** Accent-insensitive keywords, returned as written in the text. */
function keywordsOf(sentences: Sentence[], limit: number): string[] {
  const freq = new Map<string, number>();
  const original = new Map<string, string>();
  for (const s of sentences) {
    for (const match of s.text.matchAll(/[\p{L}\p{N}]+/gu)) {
      const key = normalize(match[0]);
      if (key.length <= 2 || STOPWORDS.has(key) || /^\d+$/.test(key)) continue;
      freq.set(key, (freq.get(key) ?? 0) + 1);
      if (!original.has(key)) original.set(key, match[0].toLowerCase());
    }
  }
  return [...freq.entries()]
    .filter(([, n]) => n > 1)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([k]) => original.get(k) ?? k);
}

function pickAcrossParts(sentences: Sentence[], scores: number[], count: number): { picked: Sentence[]; parts: number } {
  if (sentences.length <= count) return { picked: sentences, parts: 1 };
  const parts = Math.min(Math.max(Math.ceil(sentences.length / 40), 1), 8, count);
  const size = Math.ceil(sentences.length / parts);
  const picked: Sentence[] = [];
  for (let p = 0; p < parts; p += 1) {
    const slice = sentences.slice(p * size, (p + 1) * size);
    const quota = Math.max(1, Math.round((count * slice.length) / sentences.length));
    slice
      .map((s) => ({ s, score: scores[s.index] }))
      .sort((a, b) => b.score - a.score)
      .slice(0, quota)
      .forEach(({ s }) => picked.push(s));
  }
  // Trim to the requested size keeping the best, then restore reading order.
  return {
    picked: picked
      .sort((a, b) => scores[b.index] - scores[a.index])
      .slice(0, count)
      .sort((a, b) => a.index - b.index),
    parts,
  };
}

const toPassage = (s: Sentence): Passage => ({ text: s.text, page: s.page });

function documentDigest(content: string, length: SummaryLength): Digest {
  const target = TARGETS[length];
  const { sentences, headings, title, pages } = parseDocument(content);
  const keywords = keywordsOf(sentences, 10);
  const base: Digest = {
    kind: "document",
    title,
    overview: [],
    sections: headings,
    keyPoints: [],
    details: [],
    actions: [],
    conclusion: null,
    sheets: [],
    keywords,
    coverage: { chars: content.length, sentences: sentences.length, parts: 1, pages },
  };
  if (sentences.length === 0) return base;

  const df = new Map<string, number>();
  for (const s of sentences) for (const w of new Set(s.words)) df.set(w, (df.get(w) ?? 0) + 1);
  const keywordSet = new Set(keywords.map(normalize));
  const scores = sentences.map((s) => {
    const unique = new Set(s.words);
    let score = 0;
    for (const w of unique) score += Math.log(1 + (df.get(w) ?? 0));
    score /= Math.sqrt(Math.max(s.words.length, 6));
    for (const w of unique) if (keywordSet.has(w)) score += 0.15;
    if (s.paragraphStart) score += 0.3;
    if (NUMERIC_FACT.test(normalize(s.text))) score += 0.15;
    return score;
  });

  const lead = sentences[0];
  const { picked, parts } = pickAcrossParts(sentences, scores, target.key + 1);
  const keyPoints = picked.filter((s) => s !== lead).slice(0, target.key);
  const used = new Set<Sentence>([lead, ...keyPoints]);

  const details = sentences
    .filter((s) => !used.has(s) && NUMERIC_FACT.test(normalize(s.text)))
    .sort((a, b) => scores[b.index] - scores[a.index])
    .slice(0, target.details)
    .sort((a, b) => a.index - b.index);
  details.forEach((s) => used.add(s));

  const actions = sentences
    .filter((s) => ACTION.test(normalize(s.text)))
    .slice(0, target.actions);

  const conclusionSentence =
    [...sentences].reverse().find((s) => CONCLUSION.test(normalize(s.text))) ?? null;

  const overview: string[] = [lead.text];
  if (headings.length >= 2) {
    overview.push(`Tài liệu gồm các phần: ${headings.slice(0, 8).join("; ")}${headings.length > 8 ? "; …" : ""}.`);
  }

  return {
    ...base,
    overview,
    keyPoints: keyPoints.map(toPassage),
    details: details.map(toPassage),
    actions: actions.map(toPassage),
    conclusion: conclusionSentence ? toPassage(conclusionSentence) : null,
    coverage: { chars: content.length, sentences: sentences.length, parts, pages },
  };
}

// ----------------------------------------------------------------- tables

function parseNumber(raw: string): number | null {
  let t = raw.trim().replace(/[\s₫$€%]|vnd|vnđ|usd|đ/gi, "");
  if (!t || !/^-?[\d.,]+$/.test(t)) return null;
  if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(t)) t = t.replace(/\./g, "").replace(",", ".");
  else if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) t = t.replace(/,/g, "");
  else t = t.replace(",", ".");
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function parseCsv(text: string): string[][] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 5001);
  const sample = lines.slice(0, 10);
  const delimiter = ["\t", ";", ",", "|"]
    .map((d) => ({ d, counts: sample.map((l) => l.split(d).length) }))
    .filter(({ counts }) => counts[0] > 1)
    .sort((a, b) => {
      const consistent = (c: number[]) => c.filter((n) => n === c[0]).length;
      return consistent(b.counts) - consistent(a.counts) || b.counts[0] - a.counts[0];
    })[0]?.d ?? ",";
  return lines.map((line) => {
    const cells: string[] = [];
    let cur = "";
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (ch === '"') {
        if (quoted && line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else quoted = !quoted;
      } else if (ch === delimiter && !quoted) {
        cells.push(cur.trim());
        cur = "";
      } else cur += ch;
    }
    cells.push(cur.trim());
    return cells;
  });
}

function sheetDigest(name: string, rows: string[][]): SheetDigest {
  const [header = [], ...body] = rows;
  const width = Math.max(header.length, ...body.slice(0, 200).map((r) => r.length));
  const columns: ColumnDigest[] = [];
  for (let c = 0; c < width; c += 1) {
    const colName = header[c]?.trim() || `Cột ${c + 1}`;
    const values = body.map((r) => (r[c] ?? "").trim()).filter(Boolean);
    const numbers = values.map(parseNumber).filter((n): n is number => n !== null);
    if (values.length && numbers.length >= values.length * 0.8) {
      const sum = numbers.reduce((a, b) => a + b, 0);
      columns.push({
        name: colName,
        kind: "number",
        filled: values.length,
        sum,
        min: Math.min(...numbers),
        max: Math.max(...numbers),
        avg: sum / numbers.length,
      });
    } else {
      const freq = new Map<string, number>();
      values.forEach((v) => freq.set(v, (freq.get(v) ?? 0) + 1));
      columns.push({
        name: colName,
        kind: "text",
        filled: values.length,
        distinct: freq.size,
        top: [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([v]) => v),
      });
    }
  }
  return { name, rows: body.length, columns, sample: body.slice(0, 3) };
}

const fmt = (n: number) =>
  new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 2 }).format(n);

function tableDigest(content: string, extension: string, length: SummaryLength): Digest {
  const sheets: SheetDigest[] = content.includes(SHEET_MARKER)
    ? content
        .split(SHEET_MARKER)
        .filter((block) => block.trim())
        .map((block) => {
          const [name, ...lines] = block.split("\n");
          return sheetDigest(name.trim(), lines.filter((l) => l.trim()).map((l) => l.split("\t")));
        })
    : [sheetDigest(extension.toUpperCase(), parseCsv(content))];

  const nonEmpty = sheets.filter((s) => s.rows > 0 || s.columns.length > 0);
  const maxColumns = length === "short" ? 4 : length === "keypoints" ? 8 : 20;
  const overview = [
    nonEmpty.length > 1
      ? `Bảng tính gồm ${nonEmpty.length} sheet: ${nonEmpty.map((s) => `“${s.name}”`).join(", ")}.`
      : `Bảng dữ liệu gồm ${nonEmpty[0]?.rows ?? 0} dòng và ${nonEmpty[0]?.columns.length ?? 0} cột.`,
  ];
  const keyPoints: Passage[] = nonEmpty.map((s) => ({
    text: `Sheet “${s.name}”: ${s.rows} dòng dữ liệu, ${s.columns.length} cột (${s.columns
      .slice(0, maxColumns)
      .map((c) => c.name)
      .join(", ")}${s.columns.length > maxColumns ? ", …" : ""}).`,
    page: null,
  }));
  const details: Passage[] = [];
  for (const s of nonEmpty) {
    for (const c of s.columns.slice(0, maxColumns)) {
      if (c.kind === "number" && c.filled > 1) {
        details.push({
          text: `“${c.name}”${nonEmpty.length > 1 ? ` (${s.name})` : ""}: tổng ${fmt(c.sum!)}, trung bình ${fmt(c.avg!)}, nhỏ nhất ${fmt(c.min!)}, lớn nhất ${fmt(c.max!)} (tính từ ${c.filled} giá trị).`,
          page: null,
        });
      } else if (c.kind === "text" && length !== "short" && c.top?.length && c.distinct! <= Math.max(10, c.filled / 2)) {
        details.push({
          text: `“${c.name}”: ${c.distinct} giá trị khác nhau, thường gặp: ${c.top.join(", ")}.`,
          page: null,
        });
      }
    }
  }
  const keywordSource = sheets.flatMap((s) => s.columns.map((c) => c.name)).join(" ");
  return {
    kind: "table",
    title: null,
    overview,
    sections: [],
    keyPoints,
    details: details.slice(0, length === "short" ? 4 : length === "keypoints" ? 8 : 20),
    actions: [],
    conclusion: null,
    sheets: nonEmpty,
    keywords: contentWords(keywordSource).slice(0, 8),
    coverage: {
      chars: content.length,
      sentences: nonEmpty.reduce((n, s) => n + s.rows, 0),
      parts: nonEmpty.length || 1,
      pages: null,
    },
  };
}

const TABLE_EXTENSIONS = ["csv", "tsv", "xlsx", "ods"];

export function buildDigest(content: string, extension: string, length: SummaryLength = "keypoints"): Digest {
  const ext = extension.toLowerCase();
  if (TABLE_EXTENSIONS.includes(ext) && (ext !== "xlsx" || content.includes(SHEET_MARKER))) {
    return tableDigest(content, ext, length);
  }
  return documentDigest(content, length);
}

const withPage = (p: Passage) => (p.page ? `${p.text} (trang ${p.page})` : p.text);

/** Plain-text rendering used for "copy" and for the chat assistant. */
export function digestToText(digest: Digest, fileName: string, engineLabel: string): string {
  const lines: string[] = [`Tóm tắt: ${fileName}`, engineLabel, ""];
  const section = (title: string, items: string[]) => {
    if (!items.length) return;
    lines.push(title, ...items.map((i) => `- ${i}`), "");
  };
  section("Tổng quan", digest.overview);
  section(digest.kind === "table" ? "Cấu trúc dữ liệu" : "Các ý chính", digest.keyPoints.map(withPage));
  section(digest.kind === "table" ? "Số liệu" : "Thông tin chi tiết", digest.details.map(withPage));
  section("Việc cần thực hiện", digest.actions.map(withPage));
  if (digest.conclusion) section("Kết luận", [withPage(digest.conclusion)]);
  return lines.join("\n").trim();
}

// ------------------------------------------------------------------- Q&A

const QUESTION_WORDS = new Set(
  "gi nao bao nhieu khi dau sao the nhu la co khong ai what which when where who how many much does did is are tai lieu file nay noi dung".split(" ")
);

/** Passages of the document that best match a question (local, no AI). */
export function findPassages(content: string, question: string, limit = 3): Passage[] {
  const terms = [...new Set(contentWords(question).filter((w) => !QUESTION_WORDS.has(w)))];
  if (!terms.length) return [];
  const { sentences } = parseDocument(content);
  const qNorm = normalize(question);
  return sentences
    .map((s) => {
      const n = normalize(s.text);
      const hits = terms.filter((t) => n.includes(t)).length;
      const phrase = terms.length > 1 && n.includes(terms.join(" ")) ? 1 : 0;
      const numberBonus = /bao nhieu|how (many|much)|khi nao|when|ngay nao/.test(qNorm) && NUMERIC_FACT.test(n) ? 0.5 : 0;
      return { s, score: hits + phrase + numberBonus, hits };
    })
    .filter((x) => x.hits > 0 && x.hits >= Math.min(2, terms.length))
    .sort((a, b) => b.score - a.score || a.s.index - b.s.index)
    .slice(0, limit)
    .map(({ s }) => toPassage(s));
}
