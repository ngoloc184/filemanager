// Passage retrieval and grounded answers over the user's documents
// (framework-free; unit tested; no model, no network).
//
// Pipeline: documents that the database already filtered by permission are
// split into passages (articles, paragraphs, table rows, with page numbers),
// ranked with BM25 + phrase/heading/file-name signals, then the best
// passages are quoted verbatim with their source. Numbers are extracted with
// their units so the assistant can answer "how long / how much / the longest"
// and notice when sources disagree, without inventing anything.

import { normalize } from "./text.ts";
import { PAGE_BREAK, SHEET_MARKER } from "./extract.ts";
import { DEFAULT_TUNING, type Tuning } from "./tuning.ts";

export type SourceDoc = {
  fileId: string;
  name: string;
  extension: string;
  content: string;
  /** rank of the file in the search that found it (0 = best) */
  searchRank?: number;
  /** files the conversation is about get a small boost */
  inContext?: boolean;
};

export type Chunk = {
  fileId: string;
  index: number;
  text: string;
  page: number | null;
  heading: string | null;
  tokens: string[];
  headingTokens: string[];
  suspicious: boolean;
};

export type Quantity = {
  raw: string;
  value: number;
  unit: "duration" | "money" | "usd" | "percent" | "count";
  /** value converted to days / VND / … for comparisons */
  normalized: number;
  line: string;
  relevance: number;
};

export type Citation = {
  n: number;
  fileId: string;
  fileName: string;
  page: number | null;
  heading: string | null;
  text: string;
  score: number;
  coverage: number;
  suspicious: boolean;
};

export type Confidence = "high" | "medium" | "low" | "none";

export type Conflict = { topic: string; values: { raw: string; citation: number; fileName: string }[] };

export type QuestionShape = {
  terms: string[];
  expansions: string[];
  superlative: "max" | "min" | null;
  expects: "duration" | "money" | "percent" | "date" | "count" | null;
};

export type Retrieval = {
  shape: QuestionShape;
  citations: Citation[];
  confidence: Confidence;
  conflicts: Conflict[];
  best: { quantity: Quantity; citation: number } | null;
  suspiciousFiles: string[];
  chunksScanned: number;
};

// ------------------------------------------------------------- tokenizing

const words = (n: string) => n.split(/[^a-z0-9]+/).filter(Boolean);

const QUESTION_PHRASES = [
  "la bao nhieu", "bao nhieu", "bao lau", "bao gio", "khi nao", "luc nao", "la gi", "nhu the nao", "the nao", "o dau",
  "tai sao", "vi sao", "co phai", "hay khong", "co khong", "duoc khong", "la ai", "cho biet", "cho toi biet", "giup toi",
  "dieu khoan nao", "muc nao", "phan nao", "file nao", "tai lieu nao", "ra sao", "quy dinh the nao", "how much", "how many",
  "how long", "what is", "what are", "when is", "who is", "where is",
  "dai nhat", "lau nhat", "cao nhat", "lon nhat", "nhieu nhat", "toi da", "ngan nhat", "thap nhat", "nho nhat", "it nhat", "toi thieu",
  "tom tat", "tom luoc",
];

const QSTOP = new Set(
  (
    "la gi nao co khong duoc cua cac nhung mot trong cho voi va hay hoac thi ma ve den tu theo tai tren nay do kia ay roi chua da dang se " +
    "can phai hoi muon biet giup toi minh ban xin vui long nhe a ha file tep tai lieu van ban noi dung bao nhieu lau gio ai dau sao ra " +
    "the what which when where who how is are the a an of in on for to does do did about with by from was were be lam gi quy dinh"
  ).split(" ")
);

const SUPER_MAX = /\b(dai nhat|lau nhat|cao nhat|lon nhat|nhieu nhat|toi da|longest|highest|largest|most|maximum)\b/;
const SUPER_MIN = /\b(ngan nhat|thap nhat|nho nhat|it nhat|toi thieu|shortest|lowest|smallest|least|minimum)\b/;

function stripPhrases(n: string): string {
  let out = ` ${n} `;
  for (const p of QUESTION_PHRASES) out = out.split(` ${p} `).join(" ");
  return out.replace(/\s+/g, " ").trim();
}

/** What the question is about and what kind of answer it expects. */
export function analyzeQuestion(question: string, tuning: Tuning = DEFAULT_TUNING): QuestionShape {
  const n = normalize(question).replace(/[?!.,;:()"“”']+/g, " ").replace(/\s+/g, " ").trim();
  const superlative = SUPER_MAX.test(n) ? "max" : SUPER_MIN.test(n) ? "min" : null;
  const expects: QuestionShape["expects"] =
    /\b(bao lau|thoi han|thoi gian|trong vong|how long|duration|so ngay|may ngay)\b/.test(n) || (superlative && /\b(thoi han|thoi gian|ngay|thang)\b/.test(n))
      ? "duration"
      : /\b(khi nao|bao gio|ngay nao|luc nao|when)\b/.test(n)
        ? "date"
        : /\b(ty le|phan tram|percent)\b/.test(n)
          ? "percent"
          : /\b(bao nhieu tien|gia tri|so tien|doanh thu|chi phi|ngan sach|loi nhuan|gia|luong|how much|cost|price|budget|revenue)\b/.test(n)
            ? "money"
            : /\b(bao nhieu|how many|so luong)\b/.test(n)
              ? "count"
              : null;
  const terms = [...new Set(words(stripPhrases(n)).filter((w) => !QSTOP.has(w) && (w.length > 1 || /\d/.test(w))))].slice(0, 16);
  const expansions = new Set<string>();
  const joined = ` ${terms.join(" ")} `;
  for (const [key, values] of Object.entries(tuning.synonyms)) {
    if (!joined.includes(` ${key} `)) continue;
    for (const v of values) for (const w of words(v)) if (!terms.includes(w)) expansions.add(w);
  }
  return { terms, expansions: [...expansions].slice(0, 12), superlative, expects };
}

// --------------------------------------------------------------- injection

const INJECTION: RegExp[] = [
  /\b(ignore|disregard|forget|override) (all |any )?(of )?(the |your )?(previous|prior|above|earlier|system) (instructions?|prompts?|rules|messages|directions)\b/,
  /\bbo qua (moi |tat ca |cac |toan bo |nhung )?(huong dan|chi dan|chi thi|lenh|quy tac|yeu cau)\b/,
  /\b(system prompt|developer message|you are now|jailbreak|do anything now)\b/,
  /\b(new|updated) instructions?:/,
  /\b(hay|please|you must|ban phai|tro ly phai|ai phai)\s+(gui|send|share|chia se|xoa|delete|tiet lo|reveal|forward|cung cap)\b.{0,60}\b(mat khau|password|token|api key|tat ca|all|toan bo|du lieu|data)\b/,
  /\b(share|chia se|gui|send|forward)\b.{0,30}\b(all|tat ca|toan bo|every)\b.{0,20}\b(files?|tai lieu|du lieu|documents?)\b/,
];

/** Text that tries to instruct an AI. It is treated as data, never obeyed. */
export function looksLikeInjection(text: string): boolean {
  if (/<\/?(system|assistant|instructions?|im_start|im_end)>/i.test(text)) return true;
  const n = normalize(text);
  return INJECTION.some((p) => p.test(n));
}

// --------------------------------------------------------------- chunking

const MAX_CHUNK = 700;

function isHeadingLine(line: string): boolean {
  const t = line.trim();
  if (!t || t.length > 90) return false;
  if (/^#{1,6}\s/.test(t)) return true;
  if (/^(điều|dieu|chương|chuong|mục|muc|phần|phan|article|section|chapter)\s+[\dIVXLC]+[.:)]?(\s|$)/i.test(t)) return true;
  if (/^[IVXLC]+\.\s/.test(t) || /^\d+(\.\d+)*[.)]\s+\S/.test(t)) return t.length < 70 && !/[.;]$/.test(t);
  const letters = t.replace(/[^\p{L}]/gu, "");
  return letters.length >= 4 && letters === letters.toUpperCase() && !/[.;]$/.test(t);
}

function splitLong(text: string): string[] {
  if (text.length <= MAX_CHUNK) return [text];
  const sentences = text.split(/(?<=[.!?;])\s+/);
  const out: string[] = [];
  let cur = "";
  for (const s of sentences) {
    if (cur && cur.length + s.length > MAX_CHUNK) {
      out.push(cur);
      cur = "";
    }
    cur = cur ? `${cur} ${s}` : s;
    while (cur.length > MAX_CHUNK * 1.5) {
      out.push(cur.slice(0, MAX_CHUNK));
      cur = cur.slice(MAX_CHUNK);
    }
  }
  if (cur) out.push(cur);
  return out;
}

function makeChunk(fileId: string, index: number, text: string, page: number | null, heading: string | null): Chunk {
  const clean = text.trim();
  return {
    fileId,
    index,
    text: clean,
    page,
    heading,
    tokens: words(normalize(clean)),
    headingTokens: heading ? words(normalize(heading)) : [],
    suspicious: looksLikeInjection(clean),
  };
}

function tableChunks(doc: SourceDoc): Chunk[] {
  const chunks: Chunk[] = [];
  const blocks = doc.content.includes(SHEET_MARKER)
    ? doc.content.split(SHEET_MARKER).filter(Boolean).map((b) => {
        const [name, ...rows] = b.split("\n");
        return { name: name.trim(), rows };
      })
    : [{ name: null as string | null, rows: doc.content.split("\n") }];
  for (const block of blocks) {
    const rows = block.rows.filter((r) => r.trim());
    if (!rows.length) continue;
    const delimiter = rows[0].includes("\t") ? "\t" : rows[0].split(";").length > rows[0].split(",").length ? ";" : ",";
    const header = rows[0].split(delimiter).map((h) => h.trim());
    for (const row of rows.slice(1, 2001)) {
      const cells = row.split(delimiter).map((c) => c.trim());
      const text = cells
        .map((c, i) => (i === 0 ? c : c && header[i] ? `${header[i]}: ${c}` : c))
        .filter(Boolean)
        .join("; ");
      if (text) chunks.push(makeChunk(doc.fileId, chunks.length, text, null, block.name ? `Sheet ${block.name}` : null));
    }
  }
  return chunks;
}

/** Splits one document into passages with page numbers and section titles. */
export function chunkDocument(doc: SourceDoc): Chunk[] {
  const ext = doc.extension.toLowerCase();
  if (["csv", "tsv", "xlsx", "ods", "xls"].includes(ext) && (ext !== "xlsx" || doc.content.includes(SHEET_MARKER))) {
    return tableChunks(doc);
  }
  const chunks: Chunk[] = [];
  const pages = doc.content.split(PAGE_BREAK);
  const paged = pages.length > 1;
  let heading: string | null = null;
  pages.forEach((pageText, p) => {
    let buf: string[] = [];
    const flush = () => {
      const text = buf.join("\n").trim();
      buf = [];
      if (!text) return;
      for (const part of splitLong(text)) chunks.push(makeChunk(doc.fileId, chunks.length, part, paged ? p + 1 : null, heading));
    };
    for (const raw of pageText.split("\n")) {
      const line = raw.trim();
      if (!line) {
        if (buf.join(" ").length > 200) flush();
        continue;
      }
      if (isHeadingLine(line)) {
        flush();
        heading = line.replace(/^#+\s*/, "");
        buf.push(line.replace(/^#+\s*/, ""));
        continue;
      }
      buf.push(line);
      if (buf.join(" ").length > MAX_CHUNK) flush();
    }
    flush();
  });
  return chunks;
}

// -------------------------------------------------------------- quantities

const UNIT_RE =
  /^\s*(%|phan tram|ngay lam viec|ngay|thang|nam|tuan|gio|phut|trieu dong|trieu|ty dong|ty|nghin dong|nghin|ngan|dong|vnd|d\b|usd|\$|doanh nghiep|khach hang|nguoi|nhan vien|don hang)/;

const UNIT_INFO: Record<string, { unit: Quantity["unit"]; factor: number }> = {
  "%": { unit: "percent", factor: 1 },
  "phan tram": { unit: "percent", factor: 1 },
  "ngay lam viec": { unit: "duration", factor: 1 },
  ngay: { unit: "duration", factor: 1 },
  tuan: { unit: "duration", factor: 7 },
  thang: { unit: "duration", factor: 30 },
  nam: { unit: "duration", factor: 365 },
  gio: { unit: "duration", factor: 1 / 24 },
  phut: { unit: "duration", factor: 1 / 1440 },
  "trieu dong": { unit: "money", factor: 1e6 },
  trieu: { unit: "money", factor: 1e6 },
  "ty dong": { unit: "money", factor: 1e9 },
  ty: { unit: "money", factor: 1e9 },
  "nghin dong": { unit: "money", factor: 1e3 },
  nghin: { unit: "money", factor: 1e3 },
  ngan: { unit: "money", factor: 1e3 },
  dong: { unit: "money", factor: 1 },
  vnd: { unit: "money", factor: 1 },
  d: { unit: "money", factor: 1 },
  usd: { unit: "usd", factor: 1 },
  $: { unit: "usd", factor: 1 },
};

export function parseNumber(raw: string): number | null {
  let s = raw.trim();
  if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, "");
  else if (/^\d{1,3}(,\d{3})+$/.test(s)) s = s.replace(/,/g, "");
  else if (/^\d{1,3}(\.\d{3})+,\d+$/.test(s)) s = s.replace(/\./g, "").replace(",", ".");
  else if (/^\d{1,3}(,\d{3})+\.\d+$/.test(s)) s = s.replace(/,/g, "");
  else s = s.replace(",", ".");
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
}

/** Numbers with units in a line ("45 ngày", "120.000.000 VNĐ", "8%"). */
export function extractQuantities(line: string): Omit<Quantity, "relevance">[] {
  const nfc = line.normalize("NFC");
  let n = normalize(nfc);
  if (n.length !== nfc.length) return [];
  // dates and document numbers are not quantities
  n = n.replace(/\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b|\bso \d+\/\d+\b/g, (m) => " ".repeat(m.length));
  const out: Omit<Quantity, "relevance">[] = [];
  for (const m of n.matchAll(/(?<![\d/])(\d{1,3}(?:[.,]\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?)(?![\d/])/g)) {
    const start = m.index ?? 0;
    const after = n.slice(start + m[0].length);
    const unitMatch = after.match(UNIT_RE);
    // a "năm" right before a 4-digit number is a year ("năm 2026"), not a unit
    if (!unitMatch) continue;
    const key = unitMatch[1];
    const info = UNIT_INFO[key] ?? { unit: "count" as const, factor: 1 };
    const value = parseNumber(m[0]);
    if (value === null) continue;
    if (info.unit === "duration" && key === "nam" && value > 100) continue;
    const end = start + m[0].length + unitMatch[0].length;
    out.push({
      raw: nfc.slice(start, end).trim(),
      value,
      unit: info.unit,
      normalized: value * info.factor,
      line: nfc.trim(),
    });
  }
  return out;
}

// ----------------------------------------------------------------- ranking

// Lines, then sentences; "Điều 2. Giá trị…" is not split after the number.
const sentenceSplit = (text: string) =>
  text
    .split(/\n+|(?<=[^\d\s][.!?;])\s+(?=\p{Lu})/u)
    .map((s) => s.trim())
    .filter(Boolean);

function coverageOf(tokens: Set<string>, terms: string[]): number {
  if (!terms.length) return 0;
  return terms.filter((t) => tokens.has(t)).length / terms.length;
}

function bigramHits(tokens: string[], terms: string[]): number {
  if (terms.length < 2) return 0;
  const grams = new Set<string>();
  for (let i = 0; i < tokens.length - 1; i += 1) grams.add(`${tokens[i]} ${tokens[i + 1]}`);
  let hits = 0;
  for (let i = 0; i < terms.length - 1; i += 1) if (grams.has(`${terms[i]} ${terms[i + 1]}`)) hits += 1;
  return hits;
}

const EXPECT_RE: Record<NonNullable<QuestionShape["expects"]>, RegExp> = {
  duration: /\d+\s*(ngay|thang|nam|tuan|gio)\b/,
  money: /\d[\d.,]*\s*(trieu|ty|dong|vnd|usd|nghin)\b|\d[\d.,]*\s*(d|\$)(\s|$)/,
  percent: /\d[\d.,]*\s*(%|phan tram)/,
  date: /\d{1,2}\/\d{1,2}\/\d{2,4}|\bngay \d{1,2}\b|\bthang \d{1,2}\b/,
  count: /\d/,
};

/** A short quote: the sentences of the passage that answer the question. */
function quoteOf(chunk: Chunk, terms: string[], limit: number, mustInclude?: string): string {
  const sentences = sentenceSplit(chunk.text).filter((s) => !looksLikeInjection(s) && s !== chunk.heading);
  if (!sentences.length) return "";
  const scored = sentences.map((s, i) => {
    const t = new Set(words(normalize(s)));
    return { s, i, score: coverageOf(t, terms) + (mustInclude && s.includes(mustInclude) ? 2 : 0) };
  });
  const picked = [...scored].sort((a, b) => b.score - a.score || a.i - b.i).slice(0, limit).sort((a, b) => a.i - b.i);
  let quote = picked.map((p) => p.s).join(" ");
  if (quote.length > 360) quote = `${quote.slice(0, 357).trimEnd()}…`;
  return quote;
}

export type RankOptions = { tuning?: Tuning; limit?: number; perFile?: number; quoteSentences?: number };

/** Ranks passages of the given (already permission-checked) documents. */
export function retrieve(docs: SourceDoc[], question: string, options: RankOptions = {}): Retrieval {
  const tuning = options.tuning ?? DEFAULT_TUNING;
  const w = tuning.weights;
  const shape = analyzeQuestion(question, tuning);
  const limit = options.limit ?? 3;
  const perFile = options.perFile ?? 2;
  const empty: Retrieval = { shape, citations: [], confidence: "none", conflicts: [], best: null, suspiciousFiles: [], chunksScanned: 0 };
  if (!shape.terms.length || !docs.length) return empty;

  const chunks = docs.flatMap((d) => chunkDocument(d));
  if (!chunks.length) return empty;
  const nameTokens = new Map(docs.map((d) => [d.fileId, new Set(words(normalize(d.name.replace(/[-_.]+/g, " "))))]));
  const docTokens = new Map(docs.map((d) => [d.fileId, new Set(words(normalize(d.content)))]));

  // BM25 statistics over the candidate passages
  const all = [...shape.terms, ...shape.expansions];
  const df = new Map<string, number>();
  for (const c of chunks) {
    const set = new Set([...c.tokens, ...c.headingTokens]);
    for (const t of all) if (set.has(t)) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const N = chunks.length;
  const avgLen = chunks.reduce((s, c) => s + c.tokens.length, 0) / N || 1;
  const idf = (t: string) => Math.log(1 + (N - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5));

  const ranked = chunks.map((c) => {
    const tf = new Map<string, number>();
    for (const t of c.tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    let bm25 = 0;
    for (const t of all) {
      const f = tf.get(t) ?? 0;
      if (!f) continue;
      const weight = shape.terms.includes(t) ? 1 : w.expansion;
      bm25 += weight * idf(t) * ((f * 2.2) / (f + 1.2 * (0.25 + 0.75 * (c.tokens.length / avgLen))));
    }
    const tokenSet = new Set(c.tokens);
    const headingSet = new Set(c.headingTokens);
    const passageCov = coverageOf(new Set([...c.tokens, ...c.headingTokens]), shape.terms);
    const nameCov = coverageOf(nameTokens.get(c.fileId)!, shape.terms);
    const docCov = coverageOf(docTokens.get(c.fileId)!, shape.terms);
    const combinedCov = coverageOf(new Set([...tokenSet, ...headingSet, ...nameTokens.get(c.fileId)!]), shape.terms);
    const bigrams = bigramHits(c.tokens, shape.terms);
    const norm = normalize(c.text);
    const doc = docs.find((d) => d.fileId === c.fileId)!;
    const score =
      w.bm25 * bm25 +
      w.bigram * bigrams +
      w.heading * shape.terms.filter((t) => headingSet.has(t)).length +
      w.name * nameCov +
      w.docCoverage * docCov +
      (shape.expects && EXPECT_RE[shape.expects].test(norm) ? w.quantity : 0) +
      (doc.inContext ? w.context : 0) -
      (doc.searchRank ?? 0) * 0.05 -
      (c.suspicious ? 0.5 : 0);
    return { c, score, passageCov, combinedCov, bigrams, doc };
  });
  ranked.sort((a, b) => b.score - a.score || a.c.index - b.c.index);

  const best = ranked[0];
  const levels: Confidence[] = ["none", "low", "medium", "high"];
  let level = 0;
  if (best && best.passageCov > 0) {
    const cov = best.combinedCov;
    level = cov >= tuning.thresholds.high ? 3 : cov >= tuning.thresholds.medium ? 2 : cov >= tuning.thresholds.low ? 1 : 0;
    // Several words matched one by one, never as a phrase: weaker evidence.
    if (level > 0 && shape.terms.length >= 3 && best.bigrams === 0 && cov < tuning.thresholds.high) level -= 1;
  }
  const confidence = levels[level];
  if (confidence === "none") return { ...empty, chunksScanned: N };

  // Pick passages: best first, at most `perFile` per file, only reasonably relevant ones.
  const picked: typeof ranked = [];
  const perFileCount = new Map<string, number>();
  for (const r of ranked) {
    if (picked.length >= limit) break;
    if (r.score < best.score * 0.45 || r.passageCov === 0) break;
    const count = perFileCount.get(r.c.fileId) ?? 0;
    if (count >= perFile) continue;
    perFileCount.set(r.c.fileId, count + 1);
    picked.push(r);
  }

  // Quantities that answer the question, scored by how well their own line matches.
  let facts: { q: Quantity; pick: number }[] = [];
  if (shape.expects || shape.superlative) {
    picked.forEach((r, i) => {
      for (const line of sentenceSplit(r.c.text)) {
        if (looksLikeInjection(line)) continue;
        const lineTokens = words(normalize(line));
        const lineCov = coverageOf(new Set(lineTokens), shape.terms);
        const headCov = coverageOf(new Set(r.c.headingTokens), shape.terms);
        const label = line.match(/^([^:]{2,60}):\s*\S/);
        const labelCov = label ? coverageOf(new Set(words(normalize(label[1]))), shape.terms) : 0;
        const relevance = lineCov + 0.15 * bigramHits(lineTokens, shape.terms) + 0.5 * headCov + (labelCov > 0 ? 0.2 : 0);
        for (const q of extractQuantities(line)) {
          if (shape.expects && shape.expects !== "count" && shape.expects !== "date" && q.unit !== shape.expects && !(shape.expects === "money" && q.unit === "usd")) continue;
          facts.push({ q: { ...q, relevance }, pick: i });
        }
      }
    });
    const top = Math.max(0, ...facts.map((f) => f.q.relevance));
    facts = facts.filter((f) => f.q.relevance > 0 && f.q.relevance >= top * 0.75);
  }

  let bestFact: (typeof facts)[number] | null = null;
  if (facts.length) {
    if (shape.superlative) {
      const units = facts.reduce<Record<string, number>>((acc, f) => ({ ...acc, [f.q.unit]: (acc[f.q.unit] ?? 0) + 1 }), {});
      const mainUnit = Object.entries(units).sort((a, b) => b[1] - a[1])[0][0];
      const pool = facts.filter((f) => f.q.unit === mainUnit);
      bestFact = pool.reduce((a, b) => ((shape.superlative === "max" ? b.q.normalized > a.q.normalized : b.q.normalized < a.q.normalized) ? b : a));
    } else {
      bestFact = [...facts].sort((a, b) => b.q.relevance - a.q.relevance || a.pick - b.pick)[0];
    }
  }

  // Put the passage holding the answer first.
  if (bestFact && bestFact.pick !== 0) {
    const [moved] = picked.splice(bestFact.pick, 1);
    picked.unshift(moved);
    facts = facts.map((f) => ({ ...f, pick: f.pick === bestFact!.pick ? 0 : f.pick < bestFact!.pick ? f.pick + 1 : f.pick }));
    bestFact = { ...bestFact, pick: 0 };
  }

  const citations: Citation[] = picked.map((r, i) => {
    const mustInclude = facts.find((f) => f.pick === i)?.q.raw;
    return {
      n: i + 1,
      fileId: r.c.fileId,
      fileName: r.doc.name,
      page: r.c.page,
      heading: r.c.heading,
      text: quoteOf(r.c, shape.terms, options.quoteSentences ?? 2, mustInclude),
      score: Math.round(r.score * 100) / 100,
      coverage: Math.round(r.combinedCov * 100) / 100,
      suspicious: r.c.suspicious,
    };
  });

  // Same kind of value, different numbers in different files -> conflict.
  // Only files that match the question as well as the best one (a question
  // about "the 2026 contract" does not conflict with the 2025 one).
  const conflicts: Conflict[] = [];
  if (!shape.superlative && facts.length > 1) {
    const topCov = Math.max(...picked.map((p) => p.combinedCov));
    const eligible = facts.filter((f) => picked[f.pick].combinedCov >= topCov - 0.1);
    const byUnit = new Map<string, typeof facts>();
    for (const f of eligible) byUnit.set(f.q.unit, [...(byUnit.get(f.q.unit) ?? []), f]);
    for (const group of byUnit.values()) {
      const perFileBest = new Map<string, (typeof facts)[number]>();
      for (const f of group) {
        const fileId = picked[f.pick].c.fileId;
        const prev = perFileBest.get(fileId);
        if (!prev || f.q.relevance > prev.q.relevance) perFileBest.set(fileId, f);
      }
      const values = [...perFileBest.values()];
      if (values.length > 1 && new Set(values.map((v) => v.q.normalized)).size > 1) {
        conflicts.push({
          topic: shape.terms.slice(0, 4).join(" "),
          values: values.map((v) => ({ raw: v.q.raw, citation: v.pick + 1, fileName: picked[v.pick].doc.name })),
        });
      }
    }
  }

  return {
    shape,
    citations,
    confidence,
    conflicts,
    best: bestFact ? { quantity: bestFact.q, citation: bestFact.pick + 1 } : null,
    suspiciousFiles: [...new Set(picked.filter((r) => r.c.suspicious).map((r) => r.doc.name))],
    chunksScanned: N,
  };
}

/** Removes instruction-like sentences before text is ever given to a model. */
export function stripInjections(text: string): string {
  return sentenceSplit(text)
    .map((s) => (looksLikeInjection(s) ? "[đoạn giống chỉ thị cho AI đã được loại bỏ]" : s))
    .join("\n");
}
