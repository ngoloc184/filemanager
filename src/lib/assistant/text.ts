// Text helpers shared by the assistant (framework-free; unit tested).

/** Lower-case, accent-free text ("Hợp Đồng" -> "hop dong"). Mirrors fm_normalize() in SQL. */
export function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase();
}

/** Splits normalized text into word tokens (letters/digits). */
export function tokenize(normalized: string): string[] {
  return normalized.split(/[^a-z0-9@.+#]+/).filter(Boolean);
}

/** Removes whole-word phrases (normalized) from normalized text. */
export function removePhrases(normalized: string, phrases: readonly string[]): string {
  let out = ` ${normalized} `;
  for (const phrase of phrases) {
    const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`(?<=[^a-z0-9])${escaped}(?=[^a-z0-9])`, "g"), " ");
  }
  return out.replace(/\s+/g, " ").trim();
}

export function hasPhrase(normalized: string, pattern: RegExp): boolean {
  return pattern.test(normalized);
}

const VI_STOP = [
  "tim giup toi", "tim giup", "giup toi", "giup minh", "cho toi", "cho minh", "tim kiem", "liet ke",
  "hien thi", "cho xem", "nhung file", "cac file", "file nao", "tai lieu nao", "nhung tai lieu",
  "cac tai lieu", "tai lieu", "van ban", "thu muc", "co nhung", "lien quan den", "lien quan toi",
  "lien quan", "noi dung", "nhac den", "nhac toi", "de cap den", "de cap", "co chua", "co nhac",
  "duoc chia se", "chia se", "cua toi", "cua minh", "gan day", "moi nhat", "tai len", "cap nhat",
  "xin chao", "vui long", "lam on", "hien co", "dang co", "o dau", "the nao", "nhu the nao",
  "tim", "xem", "file", "tep", "folder", "co", "nao", "nhung", "cac", "toi", "minh", "ban", "ve",
  "den", "trong", "la", "gi", "khong", "a", "nhe", "voi", "va", "hoac", "hay", "da", "dang",
  "duoc", "moi", "nhat", "cho", "giup", "di", "nha", "ah", "ha", "u", "o", "tu", "mot", "so",
  "nay", "kia", "do", "thi", "ma", "neu", "bi", "phai", "can", "muon", "biet", "co the",
];

const EN_STOP = [
  "please", "can you", "could you", "show me", "find me", "look for", "search for", "related to",
  "about", "files", "file", "documents", "document", "docs", "find", "search", "show",
  "list", "me", "my", "the", "a", "an", "of", "for", "to", "with", "any", "all", "what",
  "which", "do", "i", "have", "in", "on", "is", "are", "that", "this", "those", "these",
  "there", "mention", "mentions", "mentioning", "contain", "contains", "containing", "content",
  "where", "get", "give", "some",
];

/** Multi-word phrases first so "tai lieu" is removed before "tai". */
export const STOP_PHRASES: readonly string[] = [...VI_STOP, ...EN_STOP].sort(
  (a, b) => b.split(" ").length - a.split(" ").length || b.length - a.length
);
