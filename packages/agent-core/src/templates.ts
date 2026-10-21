// Sentence templates -> matchers. A tool declares how people ask for it:
//
//   "(chuyen|di chuyen|dua|them) {file} (vao|sang|toi) (thu muc|folder)? {folder}"
//
//   word         a literal word (folded: lower case, no accents)
//   (a|b c)      one of the alternatives; "(…)?" makes the group optional
//   {name}       a slot (one or more words); "{name?}" is an optional slot
//
// Templates match the whole message (after polite words such as "hãy",
// "giúp tôi", "nhé", "ạ" are allowed around it), so a template never fires on
// a sentence that merely contains its words somewhere.

import { foldWithMap, originalSpan, type Folded } from "./text.ts";

export type TemplateMatch = {
  template: string;
  /** share of the message covered by literal words (0..1); higher is more specific */
  score: number;
  /** slot values cut from the original message (accents and case kept) */
  slots: Record<string, string>;
  /** the same values folded */
  folded: Record<string, string>;
};

export type CompiledTemplate = {
  source: string;
  regex: RegExp;
  slotNames: string[];
  /** number of literal words, used to break ties */
  literals: number;
};

const POLITE_PREFIX = [
  "hay", "giup toi", "giup minh", "giup em", "giup", "vui long", "ban oi", "ban", "xin", "cho toi", "cho minh",
  "toi muon", "minh muon", "em muon", "toi can", "minh can", "nho ban", "lam on", "please", "can you", "could you",
  "i want to", "i would like to", "let s", "ok", "oke", "uh", "um",
];
const POLITE_SUFFIX = ["nhe", "nha", "nhe ban", "giup toi", "giup minh", "duoc khong", "dum", "dum toi", "please", "a", "di", "thanks", "cam on"];

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const words = (s: string) => s.trim().split(/\s+/).filter(Boolean);
const alternation = (list: string[]) =>
  [...list].sort((a, b) => b.length - a.length).map((alt) => words(alt).map(escape).join("\\s")).join("|");

const PREFIX = `(?:\\s(?:${alternation(POLITE_PREFIX)}))*`;
const SUFFIX = `(?:\\s(?:${alternation(POLITE_SUFFIX)}))*`;

type Part =
  | { kind: "word"; value: string }
  | { kind: "group"; alts: string[]; optional: boolean }
  | { kind: "slot"; name: string; optional: boolean };

function parse(template: string): Part[] {
  const parts: Part[] = [];
  const re = /\(([^()]*)\)(\?)?|\{([a-z_][a-z0-9_]*)(\?)?\}|([a-z0-9]+)/g;
  let m: RegExpExecArray | null;
  let consumed = 0;
  while ((m = re.exec(template))) {
    if (template.slice(consumed, m.index).trim()) throw new Error(`Invalid template near "${template.slice(consumed, m.index)}" in "${template}"`);
    consumed = m.index + m[0].length;
    if (m[1] !== undefined) {
      const alts = m[1].split("|").map((a) => words(a).join(" ")).filter(Boolean);
      if (!alts.length) throw new Error(`Empty group in "${template}"`);
      parts.push({ kind: "group", alts, optional: m[2] === "?" });
    } else if (m[3] !== undefined) {
      parts.push({ kind: "slot", name: m[3], optional: m[4] === "?" });
    } else {
      parts.push({ kind: "word", value: m[5] });
    }
  }
  if (template.slice(consumed).trim()) throw new Error(`Invalid template "${template}"`);
  return parts;
}

export function compileTemplate(source: string): CompiledTemplate {
  const parts = parse(source);
  const slotNames: string[] = [];
  let literals = 0;
  const lastSlot = parts.map((p) => p.kind).lastIndexOf("slot");
  const body = parts
    .map((p, i) => {
      if (p.kind === "word") {
        literals++;
        return `\\s${escape(p.value)}`;
      }
      if (p.kind === "group") {
        if (!p.optional) literals++;
        return `(?:\\s(?:${alternation(p.alts)}))${p.optional ? "?" : ""}`;
      }
      if (slotNames.includes(p.name)) throw new Error(`Duplicate slot {${p.name}} in "${source}"`);
      slotNames.push(p.name);
      // the last slot is greedy so trailing words stay in the value; others are lazy
      const value = i === lastSlot ? ".+" : ".+?";
      return p.optional ? `(?:\\s(?<${p.name}>${value}))?` : `\\s(?<${p.name}>${value})`;
    })
    .join("");
  return { source, regex: new RegExp(`^${PREFIX}${body}${SUFFIX}$`, "d"), slotNames, literals };
}

/** Removes polite particles a greedy final slot may have swallowed ("Q3 nhé"). */
function trimSuffix(folded: string): number {
  const ws = folded.split(" ");
  let keep = ws.length;
  const suffixes = POLITE_SUFFIX.map(words).sort((a, b) => b.length - a.length);
  let changed = true;
  while (changed && keep > 1) {
    changed = false;
    for (const s of suffixes) {
      if (s.length < keep && ws.slice(keep - s.length, keep).join(" ") === s.join(" ")) {
        keep -= s.length;
        changed = true;
        break;
      }
    }
  }
  return ws.slice(0, keep).join(" ").length;
}

export function matchTemplate(compiled: CompiledTemplate, raw: string, folded: Folded = foldWithMap(raw)): TemplateMatch | null {
  if (!folded.text) return null;
  const m = compiled.regex.exec(` ${folded.text}`);
  if (!m) return null;
  const slots: Record<string, string> = {};
  const foldedSlots: Record<string, string> = {};
  let slotChars = 0;
  const indices = (m as RegExpExecArray & { indices?: { groups?: Record<string, [number, number] | undefined> } }).indices;
  const last = compiled.slotNames[compiled.slotNames.length - 1];
  for (const name of compiled.slotNames) {
    const span = indices?.groups?.[name];
    if (!span) continue;
    // -1: the matched string starts with an added space
    const from = span[0] - 1;
    let to = span[1] - 1;
    if (name === last) to = from + trimSuffix(folded.text.slice(from, to));
    const value = originalSpan(raw, folded, from, to).trim();
    if (!value) continue;
    slots[name] = value;
    foldedSlots[name] = folded.text.slice(from, to);
    slotChars += to - from;
  }
  const length = folded.text.length;
  return { template: compiled.source, score: (length - slotChars) / length, slots, folded: foldedSlots };
}
