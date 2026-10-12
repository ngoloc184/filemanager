// Rule-based question understanding (no LLM, no network). Turns a free-text
// question (Vietnamese or English) into one of a fixed set of intents with
// validated parameters. Only these intents can ever reach the database.

import { STOP_PHRASES, normalize, originalSlice, removePhrases, tokenize } from "./text.ts";

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
  | { kind: "ask"; question: string; terms: string[] }
  | { kind: "compare"; terms: string[]; topic: string[] }
  | { kind: "export"; format: "xlsx" | "csv" | "md" | "txt" | null }
  | { kind: "create_folder"; name: string }
  | { kind: "rename"; name: string; terms: string[] }
  | { kind: "move"; folder: string | null; terms: string[] }
  | { kind: "share"; email: string; role: "viewer" | "editor"; terms: string[] }
  | { kind: "refuse"; reason: "delete" | "public" | "bulk" }
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

const FIND_WORDS =
  /\b(tim|tim kiem|liet ke|list|search|find|hien thi|file nao|tep nao|tai lieu nao|nhung file|cac file|co file|co tai lieu|file gi|nhung tai lieu|cac tai lieu)\b/;
const QUESTION_WORDS =
  /\b(la gi|bao nhieu|bao lau|bao gio|khi nao|luc nao|ngay nao|the nao|nhu the nao|ra sao|o dau|tai sao|vi sao|la ai|ai la|co phai|hay khong|dieu khoan nao|muc nao|phan nao|noi dung nao|can lam gi|phai lam gi|lam gi|gom nhung gi|bao gom nhung|quy dinh gi|what|how|when|who|why|which)\b/;
const COMPARE_WORDS =
  /\b(so sanh|doi chieu|compare|khac nhau|diem khac|giong va khac|khac biet|giong nhau o)\b/;
const REF_WORDS = [
  "file nay", "file do", "file kia", "tai lieu nay", "tai lieu do", "hop dong nay", "hop dong do", "bao cao nay", "bao cao do",
  "hai file", "ca hai", "cac file tren", "hai hop dong", "hai bao cao", "hai tai lieu", "file thu nhat", "file thu hai", "file thu ba",
];

/** Name typed by the user after a marker, original casing/accents kept. */
function tail(raw: string, n: string, marker: RegExp): string | null {
  const m = n.match(marker);
  if (!m || m.index === undefined) return null;
  const value = originalSlice(raw, m.index + m[0].length).replace(/^[\s:"“'‘]+|[\s"”'’.!?]+$/g, "").trim();
  return value || null;
}

/** Write actions, refusals, comparisons, exports and content questions. */
function parseCommand(raw: string, n: string): Intent | null {
  const isMemoryTalk = /\b(bo nho|ghi nho|lich su|history|memory|cuoc tro chuyen)\b/.test(n);

  // Never through the assistant: deleting, making public, bulk permission changes.
  if (/\b(xoa|delete|remove|huy|don sach|empty)\b/.test(n) && !isMemoryTalk && /\b(file|tep|tai lieu|thu muc|folder|thung rac|trash|het|tat ca|no|nay|do)\b/.test(n)) {
    return { kind: "refuse", reason: "delete" };
  }
  const shareVerb = /\b(chia se|share|cap quyen|phan quyen|mo quyen)\b/.test(n);
  if ((shareVerb || /\b(dat|chuyen|lam|de)\b/.test(n)) && /\b(cong khai|public|cho moi nguoi|ai cung xem|bat ky ai)\b/.test(n)) {
    return { kind: "refuse", reason: "public" };
  }
  if (shareVerb && /\b(tat ca|toan bo|hang loat|all|moi) (cac |nhung )?(file|tai lieu|thu muc|documents?)\b/.test(n)) {
    return { kind: "refuse", reason: "bulk" };
  }

  const folder = n.match(/^(?:hay |giup toi |giup minh |vui long |ban )?(?:tao|create|lam|them|make)\s+(?:mot |1 |a )?(?:thu muc|folder)(?: moi| new)?(?:\s+(?:ten la|co ten|ten|named|called|la))?\s+/);
  if (folder) {
    const name = tail(raw, n, new RegExp(folder[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    if (name) return { kind: "create_folder", name };
  }

  if (/\b(doi ten|rename)\b/.test(n)) {
    const marker = n.match(/^(.*)\b(thanh|sang|to|la)\s+/);
    const name = marker ? tail(raw, n, new RegExp(`^${marker[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)) : null;
    const target = marker ? marker[1] : n;
    if (name) return { kind: "rename", name, terms: extractTerms(removePhrases(target, ["doi ten", "rename", ...REF_WORDS])) };
  }

  const move = n.match(/\b(di chuyen|chuyen|move)\b(.*?)\b(vao|sang|toi|den|into|to)\s+(?:trong\s+)?(?:thu muc|folder)?\s*/);
  if (move && !/\b(chuyen doi|convert)\b/.test(n)) {
    const dest = tail(raw, n, new RegExp(move[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    const root = !dest || /^(goc|root|thu muc goc|my files)$/.test(normalize(dest));
    return { kind: "move", folder: root ? null : dest, terms: extractTerms(removePhrases(move[2], REF_WORDS)) };
  }

  const email = raw.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,24}/);
  if (shareVerb && email && !/\b(da chia se|da share|nhung gi|nhung file nao|file nao)\b/.test(n)) {
    const role = /\b(chinh sua|sua|editor|edit|bien tap|quyen ghi)\b/.test(n) ? "editor" : "viewer";
    const target = n.split(/\b(voi|cho|with|to)\b/)[0];
    return { kind: "share", email: email[0].toLowerCase(), role, terms: extractTerms(removePhrases(target, ["chia se", "share", "cap quyen", "quyen xem", ...REF_WORDS])) };
  }

  if (/\b(xuat|export|tai xuong|download|luu (ra|thanh|vao)|tao file)\b/.test(n) && /\b(excel|xlsx|csv|markdown|md|txt|file|bang|ket qua|danh sach)\b/.test(n)) {
    const format = /\b(excel|xlsx|bang tinh)\b/.test(n)
      ? "xlsx"
      : /\bcsv\b/.test(n)
        ? "csv"
        : /\b(markdown|md)\b/.test(n)
          ? "md"
          : /\b(txt|van ban thuan|text)\b/.test(n)
            ? "txt"
            : null;
    return { kind: "export", format };
  }

  if (COMPARE_WORDS.test(n)) {
    const rest = removePhrases(n, ["so sanh", "doi chieu", "compare", "khac nhau", "diem khac", "giong va khac", "khac biet", "giong nhau o", "nhu the nao", "the nao", "giua", "voi", "va", ...REF_WORDS]);
    const terms = extractTerms(rest);
    const topic = n.match(/\b(?:ve|o|phan|muc|dieu khoan)\s+(.+?)(?:\s+(?:giua|cua|trong)\b|$)/);
    return { kind: "compare", terms, topic: topic ? extractTerms(topic[1]) : [] };
  }
  return null;
}

/** A question about the content of documents rather than a file search. */
function isContentQuestion(question: string, n: string): boolean {
  if (FIND_WORDS.test(n)) return false;
  const terms = extractTerms(n);
  if (QUESTION_WORDS.test(n)) return terms.length >= 1;
  return /\?\s*$/.test(question) && terms.length >= 3;
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

  const command = parseCommand(question, n);
  if (command) return command;

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

  if (isContentQuestion(question, n)) {
    return { kind: "ask", question, terms: extractTerms(n) };
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
