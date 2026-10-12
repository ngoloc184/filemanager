// Long-term, per-user assistant memory (framework-free; unit tested).
//
// What is remembered is decided by explicit rules, never by "learning" from
// documents: the user asks to remember something ("Hãy nhớ …"), sets a
// preference for the future ("Từ giờ trả lời ngắn gọn") or confirms a
// proposal (a term they explained). Secrets and personal identifiers are
// refused. Memories never contain file ids or file content, so revoking a
// share can never leave readable data behind in memory.

import { normalize } from "./text.ts";

export type MemoryKind = "preference" | "glossary" | "note";
export type MemorySource = "explicit" | "confirmed";

export type MemoryItem = {
  id: string;
  kind: MemoryKind;
  /** preference name ("style") or normalized glossary term; null for notes */
  key: string | null;
  value: string;
  source: MemorySource;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
};

export type MemoryInput = {
  kind: MemoryKind;
  key: string | null;
  value: string;
  source: MemorySource;
  expiresAt?: string | null;
};

/** Persistence for one signed-in user (RLS-scoped table in production). */
export interface MemoryStore {
  list(): Promise<MemoryItem[]>;
  save(input: MemoryInput): Promise<MemoryItem>;
  remove(ids: string[]): Promise<number>;
}

export const MAX_MEMORY_CHARS = 300;
export const MAX_MEMORIES = 50;
export const NOTE_TTL_DAYS = 180;

export type AnswerStyle = "short" | "normal" | "detailed";
export const STYLE_LABEL: Record<AnswerStyle, string> = {
  short: "ngắn gọn",
  normal: "bình thường",
  detailed: "chi tiết",
};

// ------------------------------------------------------------- sensitive data

const SENSITIVE_WORDS =
  /\b(mat khau|password|passwd|pwd|passcode|ma pin|pin code|otp|ma xac (thuc|nhan)|token|api ?key|secret|khoa bi mat|private key|ssh key|so the|the tin dung|credit card|cvv|cccd|cmnd|can cuoc|ho chieu|passport|so tai khoan|stk|tai khoan ngan hang|bank account|seed phrase)\b/;

const SENSITIVE_PATTERNS: RegExp[] = [
  /\b(sk|pk|rk)[-_][A-Za-z0-9_-]{16,}/,
  /\bsb_(secret|publishable)_[A-Za-z0-9_-]{8,}/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  /\b(?:\d[ -]?){12,19}\b/,
  /\b\d{9,}\b/,
  /\b(?=[A-Za-z0-9_\-]*\d)(?=[A-Za-z0-9_\-]*[A-Za-z])[A-Za-z0-9_\-]{24,}\b/,
];

/** Returns why a text must not be stored, or null when it is fine. */
export function detectSensitive(text: string): string | null {
  if (SENSITIVE_WORDS.test(normalize(text))) return "thông tin bảo mật (mật khẩu, mã, khóa, số thẻ, giấy tờ…)";
  if (SENSITIVE_PATTERNS.some((p) => p.test(text))) return "chuỗi giống mã bí mật hoặc số định danh";
  return null;
}

// -------------------------------------------------------------- interpretation

/** Slices the original text using an index found in its normalized form. */
function sliceOriginal(raw: string, normalizedIndex: number): string {
  const nfc = raw.normalize("NFC");
  return normalize(nfc).length === nfc.length ? nfc.slice(normalizedIndex) : normalize(nfc).slice(normalizedIndex);
}

const clean = (s: string) =>
  s
    .replace(/^[\s:,.-]+|[\s.!?]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();

const GLOSSARY =
  /^(?:(?:tu|chu|cum tu|thuat ngu|khi toi noi|khi minh noi)\s+)?["“]?([a-z0-9][a-z0-9 .&/+-]{0,28}?)["”]?\s+(?:la (?:tu )?viet tat cua|viet tat cua|la viet tat|co nghia la|nghia la|duoc hieu la|stands for|means)\s+(.{2,120})$/;

const STYLE_WORDS: [RegExp, AnswerStyle][] = [
  [/\b(ngan gon|ngan thoi|that ngan|tom tat ngan|ngan hon|short(er)?|brief|concise)\b/, "short"],
  [/\b(chi tiet|day du|ky hon|cu the hon|detailed|in detail)\b/, "detailed"],
  [/\b(binh thuong|vua phai|mac dinh|normal)\b/, "normal"],
];

function styleOf(n: string): AnswerStyle | null {
  if (!/\b(tra loi|tom tat|trinh bay|viet|giai thich|answer|reply|respond|summar)/.test(n) && !/^(ngan gon|chi tiet)/.test(n)) {
    return null;
  }
  for (const [pattern, style] of STYLE_WORDS) if (pattern.test(n)) return style;
  return null;
}

/** Glossary definition inside a sentence, e.g. "HĐ nghĩa là hợp đồng". */
export function parseDefinition(text: string): { term: string; meaning: string } | null {
  const nfc = clean(text.normalize("NFC"));
  const n = normalize(nfc);
  const m = n.match(GLOSSARY);
  if (!m) return null;
  const term = m[1].trim();
  const meaningStart = n.length - m[2].length;
  const meaning = clean(sliceOriginal(nfc, meaningStart));
  if (!term || !meaning || normalize(meaning) === term || meaning.length > 120) return null;
  return { term, meaning };
}

/** Turns "what to remember" into a typed memory (or a refusal). */
export function interpretMemory(text: string): { item: MemoryInput } | { rejected: string } {
  const value = clean(text).slice(0, MAX_MEMORY_CHARS + 1);
  if (!value) return { rejected: "Bạn muốn tôi ghi nhớ điều gì?" };
  if (value.length > MAX_MEMORY_CHARS) return { rejected: `Nội dung cần nhớ tối đa ${MAX_MEMORY_CHARS} ký tự.` };
  const sensitive = detectSensitive(value);
  if (sensitive) {
    return { rejected: `Tôi không lưu ${sensitive}. Hãy giữ những thông tin này ở nơi an toàn, không lưu trong trợ lý.` };
  }
  const n = normalize(value);
  if (/\b(tieng anh|english|tieng nhat|tieng trung|tieng han|tieng phap)\b/.test(n) && /\b(tra loi|noi|dung|answer|reply)\b/.test(n)) {
    return { rejected: "Hiện tôi chỉ trả lời bằng tiếng Việt nên chưa thể ghi nhớ lựa chọn ngôn ngữ khác." };
  }
  const style = styleOf(n);
  if (style) return { item: { kind: "preference", key: "style", value: style, source: "explicit" } };
  const def = parseDefinition(value);
  if (def) return { item: { kind: "glossary", key: def.term, value: def.meaning, source: "explicit" } };
  return { item: { kind: "note", key: null, value, source: "explicit" } };
}

export type MemoryCommand =
  | { kind: "save"; item: MemoryInput }
  | { kind: "rejected"; reason: string }
  | { kind: "forget"; query: string }
  | { kind: "forget_all" }
  | { kind: "list" }
  | { kind: "propose"; item: MemoryInput };

const LIST =
  /^(ban (da |dang |con )?(nho|ghi nho|biet) (duoc )?(gi|nhung gi)|(xem |hien thi |liet ke )?bo nho( cua (ban|toi|minh|tro ly))?$|ban nho gi ve (toi|minh)|what do you (remember|know about me)|show (my )?memor(y|ies))/;
const FORGET_ALL =
  /\b(quen (het|tat ca|toan bo|moi thu|sach)|xoa (het |toan bo |tat ca )?(bo nho|ghi nho|nhung gi ban nho)|forget everything|clear (your |the )?memory)\b/;
const FORGET = /^(?:hay |vui long |xin |ban )?(?:quen|dung nho|bo ghi nho|xoa ghi nho|forget)(?: (?:di|giup|rang|la|ve|cai|thong tin|dieu|viec))*\b\s*/;
// "Hãy nhớ …" / "Ghi nhớ …" / "Nhớ giúp tôi …"; a bare "nhỏ…" (small) is not a command.
const SAVE =
  /^(?:(?:hay|vui long|xin|ban|toi muon ban|giup toi|nho giup) (?:ghi nho|nho)(?: giup(?: toi| minh)?| rang| la| cho toi| ky)?\b|(?:ghi nho|nho (?:giup(?: toi| minh)?|rang|la|cho toi|ky)|luu y rang|remember(?: that)?|note that)\b|nho:)\s*/;
const FUTURE = /\b(tu (gio|nay|bay gio|lan sau)|lan sau|sau nay|ve sau|luon luon|luon|mac dinh|from now on|always)\b/;

/** Memory commands in a chat message, or null when it is not one. */
export function parseMemoryCommand(raw: string): MemoryCommand | null {
  const nfc = raw.normalize("NFC").trim();
  const n = normalize(nfc).replace(/[?!.]+$/g, "").trim();
  if (!n) return null;
  if (LIST.test(n)) return { kind: "list" };
  if (FORGET_ALL.test(n)) return { kind: "forget_all" };
  const forget = n.match(FORGET);
  if (forget) return { kind: "forget", query: clean(sliceOriginal(nfc, forget[0].length)) };
  const save = n.match(SAVE);
  if (save) {
    const result = interpretMemory(sliceOriginal(nfc, save[0].length));
    return "item" in result ? { kind: "save", item: result.item } : { kind: "rejected", reason: result.rejected };
  }
  if (FUTURE.test(n)) {
    const style = styleOf(n);
    if (style) return { kind: "save", item: { kind: "preference", key: "style", value: style, source: "explicit" } };
    if (/\b(tieng anh|english)\b/.test(n)) {
      return { kind: "rejected", reason: "Hiện tôi chỉ trả lời bằng tiếng Việt nên chưa thể ghi nhớ lựa chọn ngôn ngữ khác." };
    }
  }
  const def = parseDefinition(nfc);
  if (def && !detectSensitive(nfc)) {
    return { kind: "propose", item: { kind: "glossary", key: def.term, value: def.meaning, source: "confirmed" } };
  }
  return null;
}

// --------------------------------------------------------------------- usage

export type Profile = {
  style: AnswerStyle;
  /** normalized term -> meaning (original text) */
  glossary: { term: string; meaning: string }[];
  notes: string[];
};

export function isExpired(item: MemoryItem, now: Date): boolean {
  return Boolean(item.expiresAt && new Date(item.expiresAt).getTime() <= now.getTime());
}

export function buildProfile(items: readonly MemoryItem[], now: Date = new Date()): Profile {
  const active = items.filter((m) => !isExpired(m, now));
  const style = active.find((m) => m.kind === "preference" && m.key === "style")?.value;
  return {
    style: style === "short" || style === "detailed" ? style : "normal",
    glossary: active
      .filter((m) => m.kind === "glossary" && m.key)
      .map((m) => ({ term: normalize(m.key!), meaning: m.value })),
    notes: active.filter((m) => m.kind === "note").map((m) => m.value),
  };
}

/**
 * Rewrites the user's abbreviations with the meanings they taught
 * ("HĐ công ty A" -> "hợp đồng công ty A"). Accent- and case-insensitive.
 */
export function applyGlossary(message: string, profile: Profile): { text: string; used: { term: string; meaning: string }[] } {
  if (!profile.glossary.length) return { text: message, used: [] };
  let text = message.normalize("NFC");
  const used: { term: string; meaning: string }[] = [];
  for (const entry of [...profile.glossary].sort((a, b) => b.term.length - a.term.length)) {
    const n = normalize(text);
    if (n.length !== text.length) break;
    const escaped = entry.term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(^|[^a-z0-9])(${escaped})(?=$|[^a-z0-9])`, "g");
    const spans: [number, number][] = [];
    for (const m of n.matchAll(re)) {
      const start = (m.index ?? 0) + m[1].length;
      spans.push([start, start + m[2].length]);
    }
    if (!spans.length) continue;
    for (const [start, end] of spans.reverse()) text = text.slice(0, start) + entry.meaning + text.slice(end);
    used.push(entry);
  }
  return { text, used };
}

/** Memories that a "forget …" request most likely refers to. */
export function matchMemories(items: readonly MemoryItem[], query: string): MemoryItem[] {
  const q = normalize(query).split(/[^a-z0-9]+/).filter((w) => w.length > 1 || /\d/.test(w));
  if (!q.length) return [];
  return items
    .map((m) => {
      const hay = normalize(`${m.key ?? ""} ${m.value} ${describeMemory(m)}`);
      const words = new Set(hay.split(/[^a-z0-9]+/));
      const hits = q.filter((w) => words.has(w)).length;
      return { m, score: hits / q.length };
    })
    .filter((x) => x.score >= 0.5)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.m);
}

export function describeMemory(item: Pick<MemoryItem, "kind" | "key" | "value">): string {
  switch (item.kind) {
    case "preference":
      return item.key === "style" ? `Trả lời ${STYLE_LABEL[item.value as AnswerStyle] ?? item.value}` : `${item.key}: ${item.value}`;
    case "glossary":
      return `“${item.key}” nghĩa là “${item.value}”`;
    default:
      return item.value;
  }
}

/** Expiry for a new memory: notes fade unless refreshed; settings persist. */
export function defaultExpiry(kind: MemoryKind, now: Date = new Date()): string | null {
  return kind === "note" ? new Date(now.getTime() + NOTE_TTL_DAYS * 86_400_000).toISOString() : null;
}
