// Rule-based question understanding (no LLM, no network). Turns a free-text
// question (Vietnamese or English) into one of a fixed set of intents with
// validated parameters. Only these intents can ever reach the database.

import { STOP_PHRASES, normalize, removePhrases, tokenize } from "./text.ts";

export type Scope = "all" | "mine" | "shared";
export type DateField = "updated" | "created";

export type Filters = {
  extensions: string[] | null;
  typeLabel: string | null;
  scope: Scope;
  after: Date | null;
  before: Date | null;
  dateField: DateField;
  dateLabel: string | null;
};

export type Intent =
  | { kind: "greeting" }
  | { kind: "help" }
  | { kind: "stats" }
  | {
      kind: "find";
      /** name: metadata only · content: inside files · auto: both */
      mode: "name" | "content" | "auto";
      terms: string[];
      phrase: string;
      filters: Filters;
      sort: "relevance" | "updated" | "created";
      /** "the most recent file" style questions want a single answer */
      single: boolean;
    }
  | { kind: "my_shares"; grantee: string | null }
  | { kind: "summarize"; terms: string[]; useContext: boolean }
  | { kind: "similar"; terms: string[]; useContext: boolean }
  | { kind: "out_of_scope" }
  | { kind: "clarify" };

export const MAX_QUESTION_LENGTH = 500;

const TYPE_GROUPS: { label: string; extensions: string[]; pattern: RegExp }[] = [
  { label: "PDF", extensions: ["pdf"], pattern: /\bpdfs?\b/ },
  { label: "Word", extensions: ["doc", "docx", "odt", "rtf"], pattern: /\b(word|docx?|odt|rtf)\b/ },
  {
    label: "bảng tính",
    extensions: ["xls", "xlsx", "csv", "ods"],
    pattern: /\b(excel|xlsx?|csv|ods|bang tinh|spreadsheets?)\b/,
  },
  {
    label: "trình chiếu",
    extensions: ["ppt", "pptx", "odp", "key"],
    pattern: /\b(powerpoint|pptx?|odp|slides?|trinh chieu|presentations?)\b/,
  },
  {
    label: "hình ảnh",
    extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg", "heic", "bmp"],
    pattern: /\b(hinh anh|hinh|anh chup|images?|photos?|pictures?|png|jpe?g|gif|webp|svg)\b|\b(?:file|tep|cac|nhung|xem) anh\b|^anh\b(?! (?:oi|tim|co|can|muon|giup|xem|cho|hay|la|dang|da|nho|biet)\b)/,
  },
  { label: "video", extensions: ["mp4", "mov", "avi", "mkv", "webm"], pattern: /\b(videos?|mp4|mov|avi|mkv|webm|phim)\b/ },
  {
    label: "âm thanh",
    extensions: ["mp3", "wav", "m4a", "aac", "ogg", "flac"],
    // bare "nhac" is ambiguous: "nhắc đến" (mention) vs "nhạc" (music)
    pattern: /\b(am thanh|am nhac|bai hat|file nhac|tep nhac|nhac mp3|audio|music|mp3|wav|m4a|podcast)\b/,
  },
  {
    label: "file nén",
    extensions: ["zip", "rar", "7z", "tar", "gz"],
    pattern: /\b(file nen|tep nen|nen|zip|rar|7z|archives?)\b/,
  },
  { label: "văn bản thuần", extensions: ["txt", "md"], pattern: /\b(txt|markdown|md|text files?)\b/ },
  { label: "JSON", extensions: ["json"], pattern: /\bjson\b/ },
];

const EN_MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

const DAY_MS = 86_400_000;

/** Calendar helpers in a fixed UTC offset (default Vietnam, UTC+7). */
function startOfLocalDay(now: Date, offsetMin: number): Date {
  const local = new Date(now.getTime() + offsetMin * 60_000);
  local.setUTCHours(0, 0, 0, 0);
  return new Date(local.getTime() - offsetMin * 60_000);
}

function localParts(now: Date, offsetMin: number) {
  const local = new Date(now.getTime() + offsetMin * 60_000);
  return { year: local.getUTCFullYear(), month: local.getUTCMonth(), weekday: (local.getUTCDay() + 6) % 7 };
}

function monthRange(year: number, month: number, offsetMin: number): [Date, Date] {
  const start = new Date(Date.UTC(year, month, 1) - offsetMin * 60_000);
  const end = new Date(Date.UTC(year, month + 1, 1) - offsetMin * 60_000);
  return [start, end];
}

type DateMatch = { after: Date; before: Date | null; label: string; phrase: string; month?: number };

function parseDate(n: string, now: Date, offsetMin: number): DateMatch | null {
  const today = startOfLocalDay(now, offsetMin);
  const { year, month, weekday } = localParts(now, offsetMin);

  const simple: [RegExp, () => Omit<DateMatch, "phrase">][] = [
    [/\b(hom nay|today)\b/, () => ({ after: today, before: new Date(today.getTime() + DAY_MS), label: "hôm nay" })],
    [/\b(hom qua|yesterday)\b/, () => ({ after: new Date(today.getTime() - DAY_MS), before: today, label: "hôm qua" })],
    [/\b(tuan nay|this week)\b/, () => ({ after: new Date(today.getTime() - weekday * DAY_MS), before: null, label: "tuần này" })],
    [/\b(tuan truoc|tuan roi|last week)\b/, () => ({
      after: new Date(today.getTime() - (weekday + 7) * DAY_MS),
      before: new Date(today.getTime() - weekday * DAY_MS),
      label: "tuần trước",
    })],
    [/\b(thang nay|this month)\b/, () => {
      const [a, b] = monthRange(year, month, offsetMin);
      return { after: a, before: b, label: "tháng này" };
    }],
    [/\b(thang truoc|thang roi|last month)\b/, () => {
      const [a, b] = monthRange(year, month - 1, offsetMin);
      return { after: a, before: b, label: "tháng trước" };
    }],
    [/\b(nam nay|this year)\b/, () => ({
      after: new Date(Date.UTC(year, 0, 1) - offsetMin * 60_000),
      before: null,
      label: "năm nay",
    })],
    [/\b(nam ngoai|nam truoc|last year)\b/, () => ({
      after: new Date(Date.UTC(year - 1, 0, 1) - offsetMin * 60_000),
      before: new Date(Date.UTC(year, 0, 1) - offsetMin * 60_000),
      label: "năm ngoái",
    })],
  ];
  for (const [pattern, build] of simple) {
    const m = n.match(pattern);
    if (m) return { ...build(), phrase: m[0] };
  }

  const days = n.match(/\b(\d{1,3}) ngay (qua|gan day|truoc|vua qua)\b/) ?? n.match(/\b(?:last|past) (\d{1,3}) days?\b/);
  if (days) {
    const count = Math.min(Number(days[1]), 365);
    return { after: new Date(today.getTime() - count * DAY_MS), before: null, label: `${count} ngày qua`, phrase: days[0] };
  }

  const viMonth = n.match(/\bthang (\d{1,2})(?:(?:\/| nam )(\d{4}))?\b/);
  const enMonth = n.match(new RegExp(`\\b(${EN_MONTHS.join("|")})(?: (\\d{4}))?\\b`));
  const m = viMonth
    ? { month: Number(viMonth[1]) - 1, year: viMonth[2] ? Number(viMonth[2]) : null, phrase: viMonth[0] }
    : enMonth
      ? { month: EN_MONTHS.indexOf(enMonth[1]), year: enMonth[2] ? Number(enMonth[2]) : null, phrase: enMonth[0] }
      : null;
  if (m && m.month >= 0 && m.month <= 11) {
    // A month without a year means the latest one that is not in the future.
    const y = m.year ?? (m.month > month ? year - 1 : year);
    const [a, b] = monthRange(y, m.month, offsetMin);
    return { after: a, before: b, label: `tháng ${m.month + 1}/${y}`, phrase: m.phrase, month: m.month + 1 };
  }

  const yearOnly = n.match(/\b(?:nam|in|year) (20\d{2})\b/);
  if (yearOnly) {
    const y = Number(yearOnly[1]);
    return {
      after: new Date(Date.UTC(y, 0, 1) - offsetMin * 60_000),
      before: new Date(Date.UTC(y + 1, 0, 1) - offsetMin * 60_000),
      label: `năm ${y}`,
      phrase: yearOnly[0],
    };
  }
  return null;
}

const FILE_WORDS =
  /\b(file|files|tep|tai lieu|van ban|thu muc|folder|documents?|docs?|pdf|word|excel|anh|hinh|video|tim|liet ke|list|search|find|chia se|share|shared|upload|tai len|noi dung|hop dong|bao cao|cap nhat|gan day)\b/;

const UPLOAD_VERBS = /\b(tai len|upload(?:ed)?|tao|created?|them vao|added)\b/;
const UPDATE_VERBS = /\b(cap nhat|chinh sua|sua|updated?|modified|changed?)\b/;

function extractTerms(text: string): string[] {
  const cleaned = removePhrases(text, STOP_PHRASES);
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const token of tokenize(cleaned)) {
    const t = token.replace(/^[.+#]+|[.+#]+$/g, "");
    if (!t || (t.length < 2 && !/^\d$/.test(t)) || seen.has(t)) continue;
    seen.add(t);
    terms.push(t);
  }
  return terms.slice(0, 10);
}

export type ParseOptions = { now?: Date; utcOffsetMinutes?: number };

/** Parses a user question into a supported intent. Never throws. */
export function parseQuestion(raw: string, options: ParseOptions = {}): Intent {
  const now = options.now ?? new Date();
  const offset = options.utcOffsetMinutes ?? 420;
  const question = raw.slice(0, MAX_QUESTION_LENGTH).trim();
  const n = normalize(question).replace(/[?!.,;:()[\]{}"“”'’]+/g, " ").replace(/\s+/g, " ").trim();
  if (!n) return { kind: "clarify" };

  // greetings / help
  if (/^(xin chao|chao|hello|hi|hey|alo)( ban| bot| assistant)?$/.test(n)) return { kind: "greeting" };
  if (/\b(help|tro giup|huong dan|ban (co the )?lam (duoc )?gi|ban giup (duoc )?gi|what can you do|how do i use)\b/.test(n)) {
    return { kind: "help" };
  }

  // "what did I share with X?"
  const shareWith =
    n.match(/\b(?:toi|minh|i)\s+(?:da\s+)?(?:chia se|share|shared)\b(.*?)(?:\b(?:voi|cho|with)\s+(.+))?$/) ?? null;
  if (shareWith && !/\b(voi toi|cho toi|with me)\b/.test(n)) {
    const original = question.replace(/[?!.]+$/g, "");
    const granteeRaw = shareWith[2] ? original.split(/\s+(?:với|voi|cho|with)\s+/i).pop() ?? "" : "";
    const grantee = granteeRaw
      .replace(/\s+(không|chưa|nào|nhỉ|ạ|nhé|vậy)\s*$/u, "")
      .trim();
    return { kind: "my_shares", grantee: grantee || null };
  }

  const contextRef = /\b(file nay|tai lieu nay|tep nay|this file|this document|file do|tai lieu do)\b/.test(n);

  if (/\b(tom tat|tom luoc|summari[sz]e|summary|y chinh|noi dung chinh|thong tin chinh)\b/.test(n)) {
    const terms = extractTerms(
      removePhrases(n, ["tom tat", "tom luoc", "summarize", "summarise", "summary", "y chinh", "noi dung chinh", "thong tin chinh", "file nay", "tai lieu nay", "tep nay", "this file", "this document", "file do", "tai lieu do"])
    );
    return { kind: "summarize", terms, useContext: contextRef || terms.length === 0 };
  }

  if (/\b(tuong tu|giong nhau|giong voi|gan giong|similar|alike|like this)\b/.test(n)) {
    const terms = extractTerms(
      removePhrases(n, ["tuong tu", "giong nhau", "giong voi", "gan giong", "similar", "alike", "like this", "file nay", "tai lieu nay", "tep nay", "this file", "this document", "co noi dung", "voi"])
    );
    return { kind: "similar", terms, useContext: contextRef || terms.length === 0 };
  }

  if (/\b(thong ke|bao nhieu (file|tep|tai lieu)|tong so|tong dung luong|dung luong|statistics?|stats|how many|storage used)\b/.test(n)) {
    return { kind: "stats" };
  }

  // ---- find ---------------------------------------------------------------
  let rest = n;

  const filters: Filters = {
    extensions: null,
    typeLabel: null,
    scope: "all",
    after: null,
    before: null,
    dateField: "updated",
    dateLabel: null,
  };

  for (const group of TYPE_GROUPS) {
    const m = rest.match(group.pattern);
    if (m) {
      filters.extensions = [...(filters.extensions ?? []), ...group.extensions];
      filters.typeLabel = filters.typeLabel ? `${filters.typeLabel}, ${group.label}` : group.label;
      rest = removePhrases(rest, [m[0]]);
    }
  }

  if (/\b(duoc chia se|chia se (voi|cho) (toi|minh)|nguoi khac chia se|shared with me|duoc share)\b/.test(n)) {
    filters.scope = "shared";
    rest = removePhrases(rest, ["duoc chia se", "chia se voi toi", "chia se cho toi", "chia se voi minh", "chia se cho minh", "nguoi khac chia se", "shared with me", "duoc share"]);
  } else if (/\b(cua toi|cua minh|toi (da |moi |vua )?(tai len|upload)|my own|i (just )?uploaded|my files)\b/.test(n)) {
    filters.scope = "mine";
  }

  const uploadVerb = UPLOAD_VERBS.test(n);
  const updateVerb = UPDATE_VERBS.test(n);
  if (uploadVerb && !updateVerb) filters.dateField = "created";

  const recent = /\b(gan day|gan nhat|moi nhat|moi (tai len|cap nhat|upload|them)|vua (tai len|cap nhat|upload|them)|recent(ly)?|latest|newest|last (uploaded|updated|modified))\b/.test(n);
  const single = recent && /\b(nhat|most|latest file|newest file|the latest|the newest)\b/.test(n) && !/\b(nhung|cac|files|documents)\b/.test(n);

  const date = parseDate(rest, now, offset);
  let softDateTerms: string[] = [];
  if (date) {
    rest = removePhrases(rest, [date.phrase]);
    const termsWithoutDate = extractTerms(rest);
    // "báo cáo tháng 9" is usually part of a document name; only treat a bare
    // month as a date filter when the question is about upload/update time.
    const hardFilter = uploadVerb || updateVerb || termsWithoutDate.length === 0 || date.month === undefined;
    if (hardFilter) {
      filters.after = date.after;
      filters.before = date.before;
      filters.dateLabel = date.label;
    } else if (date.month !== undefined) {
      softDateTerms = ["thang", String(date.month)];
    }
  }

  const quoted = question.match(/["“”']([^"“”']{2,120})["“”']/);
  const contentMode = /\b(noi dung|nhac den|nhac toi|de cap|co chua|co nhac|trong noi dung|ben trong|mention(s|ing)?|contain(s|ing)?|inside)\b/.test(n);
  const topicMode = /\b(lien quan|ve chu de|chu de|ve van de|about|related)\b/.test(n) || /\btai lieu (nao )?ve\b/.test(n);

  const terms = [...extractTerms(rest), ...softDateTerms].slice(0, 10);
  const phrase = quoted ? `"${normalize(quoted[1]).trim()}"` : terms.filter((t) => !softDateTerms.includes(t)).join(" ");

  const hasFilter = Boolean(filters.extensions || filters.after || filters.scope !== "all");

  if (terms.length === 0 && !hasFilter && !recent) {
    return FILE_WORDS.test(n) ? { kind: "clarify" } : { kind: "out_of_scope" };
  }

  return {
    kind: "find",
    mode: contentMode || quoted ? "content" : topicMode ? "auto" : terms.length > 0 ? "auto" : "name",
    terms,
    phrase,
    filters,
    sort: recent ? (filters.dateField === "created" ? "created" : "updated") : terms.length ? "relevance" : "updated",
    single,
  };
}

/** True if the question looked like it was about files at all. */
export function mentionsFiles(raw: string): boolean {
  return FILE_WORDS.test(normalize(raw));
}
