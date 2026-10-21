// Self-learning without a language model.
//
// A lesson maps a way of saying something ("phrase") to a sentence the agent
// already understands ("canonical"). Lessons come from:
//   * explicit teaching: “Khi tôi nói "dọn rác" nghĩa là "xem thùng rác"”,
//     “Dạy: cất => chuyển”;
//   * implicit observation: a message nobody understood followed by a
//     rephrasing that worked (stored as a candidate; the user can confirm it
//     with one tap, which turns it into explicit teaching).
// The host's LessonStore decides who sees a lesson: its author immediately,
// everyone once enough different users taught or confirmed the same lesson
// (see the SQL in the host). Lessons are applied by rewriting the message
// before it is understood, so they can never do more than the canonical
// sentence would.

import { fold, foldWithMap, tokens } from "./text.ts";
import type { Lesson } from "./types.ts";

export const MAX_PHRASE_WORDS = 12;

/** words that separate the steps of a request ("… rồi …") */
export const STEP_WORDS: ReadonlySet<string> = new Set(["roi", "sau", "do", "va", "xong", "thi", "then", "and", "after", "that"]);
export const MAX_LESSON_CHARS = 200;

export type Teaching = { phrase: string; canonical: string };

const QUOTED = /["“”'‘’«»]([^"“”'‘’«»]{1,200})["“”'‘’«»]/g;

/** Recognizes a teaching command; returns folded phrase and canonical. */
export function parseTeaching(raw: string): Teaching | null {
  const text = raw.trim();
  // "Dạy: X => Y" / "học: X = Y"
  const arrow = text.match(/^(?:dạy|day|học|hoc|teach)\s*:?\s*(.+?)\s*(?:=>|->|=|→)\s*(.+)$/iu);
  if (arrow) return pair(arrow[1], arrow[2]);

  const f = fold(text);
  const marker =
    /^(?:(?:khi|neu|moi khi|lan sau khi) (?:toi|minh|em|anh|chi|ai|nguoi ta|ban)? ?(?:noi|go|viet|bao|hoi|nhan) (.+?) (?:thi )?(?:co )?(?:nghia la|tuc la|y la|hieu la|muon noi|la) (.+)|(?:hay )?hieu (.+?) (?:la|nghia la) (.+)|when i say (.+?) i mean (.+))$/;
  const m = f.match(marker);
  if (!m) return null;
  // prefer the quoted parts of the original message (keeps them exact)
  const quoted = [...text.matchAll(QUOTED)].map((q) => q[1]);
  if (quoted.length >= 2) return pair(quoted[0], quoted[1]);
  const [phrase, canonical] = m[1] ? [m[1], m[2]] : m[3] ? [m[3], m[4]] : [m[5], m[6]];
  return pair(phrase, canonical);
}

function pair(phraseRaw: string, canonicalRaw: string): Teaching | null {
  const phrase = fold(phraseRaw);
  const canonical = fold(canonicalRaw);
  if (!phrase || !canonical || phrase === canonical) return null;
  return { phrase, canonical };
}

/** "Quên cách nói X" / "forget X". */
export function parseForget(raw: string): string | null {
  const m = fold(raw).match(/^(?:hay )?(?:quen|bo|xoa) (?:cach noi|cach hieu|bai hoc) (.+)$|^forget (?:the )?(?:phrase|lesson) (.+)$/);
  return m ? (m[1] ?? m[2]) : null;
}

const NEGATIVE = /^(?:sai|sai roi|sai bet|khong phai|khong dung|nham roi|hieu sai roi|khong phai vay|khong phai the|wrong|that s wrong|no that s wrong)(?: roi| nhe| ban)?$/;
export const isNegativeFeedback = (raw: string) => NEGATIVE.test(fold(raw));

/** Secrets and personal data never become lessons. */
export function isSensitive(raw: string): boolean {
  return (
    /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(raw) ||
    /https?:\/\/|www\./i.test(raw) ||
    /\d{6,}/.test(raw.replace(/[\s.-]/g, "")) ||
    /\b(?:password|mat khau|token|otp|api key|secret)\b/.test(fold(raw))
  );
}

export type LessonCheck =
  | { ok: true }
  | { ok: false; reason: "sensitive" | "too_long" | "same" | "phrase_known" | "canonical_unknown" };

export function checkLesson(
  t: Teaching,
  understands: (folded: string) => boolean,
  understandsTarget: (folded: string) => boolean = understands
): LessonCheck {
  if (isSensitive(t.phrase) || isSensitive(t.canonical)) return { ok: false, reason: "sensitive" };
  if (
    tokens(t.phrase).length > MAX_PHRASE_WORDS ||
    t.phrase.length > MAX_LESSON_CHARS ||
    t.canonical.length > MAX_LESSON_CHARS
  ) {
    return { ok: false, reason: "too_long" };
  }
  if (t.phrase === t.canonical) return { ok: false, reason: "same" };
  // a phrase the agent already understands cannot be redefined (no hijacking)
  if (understands(t.phrase)) return { ok: false, reason: "phrase_known" };
  if (!understandsTarget(t.canonical)) return { ok: false, reason: "canonical_unknown" };
  return { ok: true };
}

/** True when every word of the canonical sentence is agent vocabulary. */
export function isGeneric(canonical: string, vocabulary: ReadonlySet<string>): boolean {
  const ws = tokens(canonical);
  return ws.length > 0 && ws.every((w) => vocabulary.has(w));
}

/**
 * Rewrites the message with the lessons that apply: whole-word occurrences
 * of a phrase are replaced by its canonical words, longest phrases first;
 * the user's own lessons win over global ones. Text outside the replaced
 * spans keeps its original spelling.
 */
export function applyLessons(
  raw: string,
  lessons: Lesson[],
  /**
   * words after which a lesson may start (polite words, "rồi"…). When given,
   * lessons only apply at the start of a request, never inside the names,
   * e-mails or text that follow it.
   */
  startWords?: ReadonlySet<string>
): { text: string; used: Lesson[] } {
  if (!lessons.length) return { text: raw, used: [] };
  const folded = foldWithMap(raw);
  const padded = ` ${folded.text} `;
  const canStartAt = (at: number) => {
    if (!startWords) return true;
    const before = folded.text.slice(0, at).trim();
    if (!before) return true;
    const last = before.split(" ").pop()!;
    return startWords.has(last) && before.split(" ").every((w) => startWords.has(w) || STEP_WORDS.has(w));
  };
  const ordered = [...lessons].sort(
    (a, b) => b.phrase.length - a.phrase.length || (a.scope === b.scope ? 0 : a.scope === "mine" ? -1 : 1)
  );
  type Span = { from: number; to: number; lesson: Lesson };
  const spans: Span[] = [];
  for (const lesson of ordered) {
    const needle = ` ${lesson.phrase} `;
    let at = padded.indexOf(needle);
    while (at !== -1) {
      const from = at; // folded index of the first character (padding offset cancels)
      const to = at + lesson.phrase.length;
      if (canStartAt(from) && !spans.some((s) => from < s.to && s.from < to)) spans.push({ from, to, lesson });
      at = padded.indexOf(needle, at + 1);
    }
  }
  if (!spans.length) return { text: raw, used: [] };
  spans.sort((a, b) => b.from - a.from);
  let text = raw.normalize("NFC");
  for (const s of spans) {
    const start = folded.start[s.from];
    const end = folded.end[s.to - 1];
    text = `${text.slice(0, start)}${s.lesson.canonical}${text.slice(end)}`;
  }
  const used = [...new Map(spans.map((s) => [s.lesson.id, s.lesson])).values()];
  return { text, used };
}
