// Text normalization for matching (Vietnamese-aware, no dependencies).
//
// Matching runs on a folded form: lower case, no diacritics ("đ" -> "d"),
// letters and digits only, single spaces. Every folded character remembers
// where it came from, so a span matched in the folded text can be cut out of
// the original message with its accents, case and punctuation intact
// ("Báo cáo Q3.pdf" rather than "bao cao q3 pdf").

export type Folded = {
  /** folded text: [a-z0-9] words separated by single spaces */
  text: string;
  /** start[i]: index in the original string of folded character i */
  start: number[];
  /** end[i]: index just after the original character of folded character i */
  end: number[];
};

const COMBINING = /\p{M}/gu;
const WORD_CHAR = /[\p{L}\p{N}]/u;

/** Folds one character: "Ệ" -> "e", "đ" -> "d", "ß" -> "ss". */
export function foldChar(ch: string): string {
  if (ch === "đ" || ch === "Đ") return "d";
  return ch.normalize("NFD").replace(COMBINING, "").toLowerCase();
}

export function foldWithMap(raw: string): Folded {
  const out: string[] = [];
  const start: number[] = [];
  const end: number[] = [];
  let pendingSpace = false;
  let i = 0;
  for (const ch of raw.normalize("NFC")) {
    const at = i;
    i += ch.length;
    if (!WORD_CHAR.test(ch)) {
      pendingSpace = out.length > 0;
      continue;
    }
    if (pendingSpace) {
      out.push(" ");
      start.push(at);
      end.push(at);
      pendingSpace = false;
    }
    for (const f of foldChar(ch)) {
      if (!/[a-z0-9]/.test(f)) continue;
      out.push(f);
      start.push(at);
      end.push(i);
    }
  }
  return { text: out.join(""), start, end };
}

/** Folded text only. */
export function fold(raw: string): string {
  return foldWithMap(raw).text;
}

/** Original text behind folded characters [from, to). */
export function originalSpan(raw: string, folded: Folded, from: number, to: number): string {
  if (to <= from || from >= folded.start.length) return "";
  const s = folded.start[from];
  const e = folded.end[Math.min(to, folded.end.length) - 1];
  return raw.normalize("NFC").slice(s, e);
}

export function tokens(folded: string): string[] {
  return folded ? folded.split(" ") : [];
}

/** Removes quotes and surrounding punctuation a user may type around a value. */
export function cleanValue(value: string): string {
  return value
    .replace(/^[\s"“”'‘’`«»:]+/u, "")
    .replace(/[\s"“”'‘’`«».,;:!?]+$/u, "")
    .replace(/\s+/g, " ")
    .trim();
}
