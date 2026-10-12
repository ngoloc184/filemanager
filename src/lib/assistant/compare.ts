// Side-by-side comparison of 2–3 documents (framework-free; no model).
// Values are copied from the documents; "differs" is computed, not guessed.

import { normalize } from "./text.ts";
import { extractQuantities } from "./retrieval.ts";
import { PAGE_BREAK, SHEET_MARKER } from "./extract.ts";

export type CompareDoc = {
  fileId: string;
  name: string;
  extension: string;
  size: number;
  updatedAt: string;
  folderName: string | null;
  content: string;
};

export type ComparisonRow = { label: string; values: string[]; differs: boolean; kind: "meta" | "fact" };

export type Comparison = {
  files: { id: string; name: string }[];
  rows: ComparisonRow[];
  onlyIn: { fileId: string; fileName: string; points: string[] }[];
  common: string[];
  differences: number;
};

const STOP = new Set(
  "va la cua cac co cho voi nhung mot trong khi da duoc nay do de ve tu den thi ma neu cung nhu vao ra theo tai tren duoi sau truoc ben ke ngay so".split(" ")
);
const words = (n: string) => n.split(/[^a-z0-9]+/).filter(Boolean);
const signature = (text: string) =>
  new Set(words(normalize(text)).filter((w) => !/^\d+$/.test(w) && !STOP.has(w) && w.length > 1));

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return inter / (a.size + b.size - inter);
}

function lines(content: string): string[] {
  return content
    .replaceAll(PAGE_BREAK, "\n")
    .replaceAll(SHEET_MARKER, "")
    .split(/\n+|(?<=[^\d\s][.!?;])\s+(?=\p{Lu})/u)
    .map((l) => l.trim())
    .filter((l) => l.length > 3);
}

const tidy = (s: string) => s.replace(/[.;,\s]+$/, "").trim();

type Fact = { key: string; label: string; value: string; sig: Set<string>; line: string };

function factsOf(content: string): Fact[] {
  const out: Fact[] = [];
  for (const line of lines(content)) {
    const labeled = line.match(/^([^:]{2,60}):\s*(.{1,160})$/);
    if (labeled && !/^https?$/i.test(labeled[1])) {
      out.push({ key: normalize(labeled[1]).trim(), label: tidy(labeled[1]), value: tidy(labeled[2]), sig: signature(labeled[1]), line });
      continue;
    }
    const qs = extractQuantities(line);
    if (!qs.length) continue;
    const label = tidy(line.replace(/\s+/g, " ")).slice(0, 90);
    out.push({ key: "", label, value: qs.map((q) => q.raw).join(", "), sig: signature(line), line });
  }
  return out;
}

const fmtSize = (bytes: number) => {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${parseFloat((bytes / 1024 ** i).toFixed(1))} ${units[i]}`;
};
const fmtDate = (iso: string) =>
  new Intl.DateTimeFormat("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "Asia/Ho_Chi_Minh" }).format(new Date(iso));

/** Compares documents; `topic` (normalized words) narrows the facts shown. */
export function compareDocuments(docs: CompareDoc[], topic: string[] = []): Comparison {
  const files = docs.map((d) => ({ id: d.fileId, name: d.name }));
  const rows: ComparisonRow[] = [];
  const meta = (label: string, values: string[]) =>
    rows.push({ label, values, differs: new Set(values).size > 1, kind: "meta" });
  meta("Định dạng", docs.map((d) => d.extension.toUpperCase() || "?"));
  meta("Dung lượng", docs.map((d) => fmtSize(d.size)));
  meta("Cập nhật", docs.map((d) => fmtDate(d.updatedAt)));

  const facts = docs.map((d) => factsOf(d.content));
  const used = docs.map(() => new Set<number>());
  const factRows: (ComparisonRow & { score: number })[] = [];
  const topicSet = new Set(topic);

  facts[0].forEach((fact, i) => {
    const values = [fact.value];
    const matched = [i];
    for (let d = 1; d < docs.length; d += 1) {
      let bestJ = -1;
      let bestScore = 0;
      facts[d].forEach((other, j) => {
        if (used[d].has(j)) return;
        const score = fact.key && fact.key === other.key ? 1 : jaccard(fact.sig, other.sig);
        if (score > bestScore) {
          bestScore = score;
          bestJ = j;
        }
      });
      if (bestJ >= 0 && bestScore >= 0.6) {
        values.push(facts[d][bestJ].value);
        matched.push(bestJ);
      } else {
        values.push("—");
        matched.push(-1);
      }
    }
    if (values.filter((v) => v !== "—").length < 2) return;
    matched.forEach((j, d) => j >= 0 && used[d].add(j));
    const differs = new Set(values.map((v) => normalize(v))).size > 1;
    const topical = topic.length ? [...fact.sig].filter((w) => topicSet.has(w)).length / topic.length : 0;
    factRows.push({
      label: fact.key ? fact.label : fact.label.replace(/\d[\d.,]*\s*(%|[^\s\d.,;]+)?/g, "…").replace(/(…\s*)+/g, "… ").slice(0, 80),
      values,
      differs,
      kind: "fact",
      score: (differs ? 1 : 0) + topical * 2 + (fact.key ? 0.5 : 0),
    });
  });
  factRows.sort((a, b) => b.score - a.score);
  for (const row of factRows.slice(0, 12)) rows.push({ label: row.label, values: row.values, differs: row.differs, kind: row.kind });

  // Points that only one document makes.
  const sigs = docs.map((d) => lines(d.content).map((l) => ({ l, s: signature(l) })));
  const onlyIn = docs.map((d, i) => {
    const others = sigs.filter((_, j) => j !== i).flat();
    const points = sigs[i]
      .filter(({ l, s }) => s.size >= 3 && l.length >= 25 && !others.some((o) => jaccard(s, o.s) >= 0.5))
      .slice(0, 3)
      .map(({ l }) => (l.length > 200 ? `${l.slice(0, 197)}…` : l));
    return { fileId: d.fileId, fileName: d.name, points };
  });

  const vocab = docs.map((d) => signature(d.content));
  const common = [...vocab[0]].filter((w) => w.length > 3 && vocab.every((v) => v.has(w))).slice(0, 10);
  return { files, rows, onlyIn, common, differences: rows.filter((r) => r.kind === "fact" && r.differs).length };
}

/** Plain table for export and copy. */
export function comparisonTable(c: Comparison): { columns: string[]; rows: string[][] } {
  return {
    columns: ["Tiêu chí", ...c.files.map((f) => f.name), "Khác nhau"],
    rows: c.rows.map((r) => [r.label, ...r.values, r.differs ? "Có" : "Không"]),
  };
}
