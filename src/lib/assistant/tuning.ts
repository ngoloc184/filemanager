// Retrieval tuning: weights, thresholds and synonyms shared by all users.
//
// The built-in values are what the evaluation suite was run with. An admin
// may store a new version in the `assistant_tuning` table (after running
// `npm run eval:assistant -- --tuning <file>` to check it is not worse) and
// activate it; rolling back is activating the previous version. A single
// user's feedback never changes these values directly.

export type Tuning = {
  version: string;
  weights: {
    bm25: number;
    bigram: number;
    heading: number;
    name: number;
    docCoverage: number;
    quantity: number;
    context: number;
    expansion: number;
  };
  thresholds: { high: number; medium: number; low: number };
  /** normalized term -> extra search terms (accent-free) */
  synonyms: Record<string, string[]>;
  /** documents read per question */
  maxDocs: number;
};

export const DEFAULT_TUNING: Tuning = {
  version: "builtin-1",
  weights: { bm25: 1, bigram: 0.6, heading: 0.3, name: 1.2, docCoverage: 0.8, quantity: 0.8, context: 0.3, expansion: 0.5 },
  thresholds: { high: 0.75, medium: 0.6, low: 0.45 },
  synonyms: {
    hd: ["hop dong"],
    bc: ["bao cao"],
    bctc: ["bao cao tai chinh"],
    dt: ["doanh thu"],
    ln: ["loi nhuan"],
    nv: ["nhan vien"],
    kh: ["khach hang"],
    cty: ["cong ty"],
    tt: ["thanh toan"],
    "hop dong": ["contract"],
    "thanh toan": ["chi tra", "payment"],
    "doanh thu": ["revenue", "doanh so"],
    "nhan vien": ["nhan su", "employee"],
    "bao mat": ["an toan thong tin", "security"],
    "ngan sach": ["kinh phi", "budget"],
    "thoi han": ["han", "deadline"],
  },
  maxDocs: 6,
};

const clampNumber = (value: unknown, min: number, max: number, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? Math.min(Math.max(value, min), max) : fallback;

/** Validates a stored tuning version; anything invalid falls back to defaults. */
export function mergeTuning(value: unknown): Tuning {
  if (!value || typeof value !== "object") return DEFAULT_TUNING;
  const v = value as Record<string, unknown>;
  const w = (v.weights ?? {}) as Record<string, unknown>;
  const t = (v.thresholds ?? {}) as Record<string, unknown>;
  const synonyms: Record<string, string[]> = { ...DEFAULT_TUNING.synonyms };
  if (v.synonyms && typeof v.synonyms === "object") {
    for (const [key, list] of Object.entries(v.synonyms as Record<string, unknown>).slice(0, 500)) {
      if (!/^[a-z0-9 ]{1,40}$/.test(key) || !Array.isArray(list)) continue;
      const clean = list.filter((x): x is string => typeof x === "string" && /^[a-z0-9 ]{1,40}$/.test(x)).slice(0, 8);
      if (clean.length) synonyms[key] = clean;
      else delete synonyms[key];
    }
  }
  const d = DEFAULT_TUNING;
  return {
    version: typeof v.version === "string" ? v.version.slice(0, 40) : d.version,
    weights: {
      bm25: clampNumber(w.bm25, 0, 5, d.weights.bm25),
      bigram: clampNumber(w.bigram, 0, 5, d.weights.bigram),
      heading: clampNumber(w.heading, 0, 5, d.weights.heading),
      name: clampNumber(w.name, 0, 5, d.weights.name),
      docCoverage: clampNumber(w.docCoverage, 0, 5, d.weights.docCoverage),
      quantity: clampNumber(w.quantity, 0, 5, d.weights.quantity),
      context: clampNumber(w.context, 0, 5, d.weights.context),
      expansion: clampNumber(w.expansion, 0, 1, d.weights.expansion),
    },
    thresholds: {
      high: clampNumber(t.high, 0, 1, d.thresholds.high),
      medium: clampNumber(t.medium, 0, 1, d.thresholds.medium),
      low: clampNumber(t.low, 0, 1, d.thresholds.low),
    },
    synonyms,
    maxDocs: Math.round(clampNumber(v.maxDocs, 1, 10, d.maxDocs)),
  };
}
