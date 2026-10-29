// Chat stickers (Microsoft Fluent Emoji 3D, MIT): groups, search and the
// Zalo-style suggestions shown while typing. Pure and unit-tested; the data
// (fluent.json, ~200 KB) is loaded on demand by the chat.

export type Sticker = { id: string; name: string; emoji: string; group: string; keywords: string[] };

export const STICKER_GROUPS = [
  { key: "smileys", label: "Smileys", icon: "smiling-face-with-smiling-eyes" },
  { key: "people", label: "People", icon: "waving-hand" },
  { key: "nature", label: "Animals & nature", icon: "dog-face" },
  { key: "food", label: "Food & drink", icon: "hamburger" },
  { key: "activities", label: "Activities", icon: "party-popper" },
  { key: "travel", label: "Travel & places", icon: "rocket" },
  { key: "objects", label: "Objects", icon: "light-bulb" },
  { key: "symbols", label: "Symbols", icon: "red-heart" },
] as const;

export function stickerUrl(id: string): string {
  return `/stickers/fluent/${id}.webp`;
}

/** Vietnamese words people type → stickers to offer (most fitting first). */
export const VI_KEYWORDS: Record<string, string[]> = {
  haha: ["face-with-tears-of-joy", "rolling-on-the-floor-laughing", "grinning-squinting-face", "beaming-face-with-smiling-eyes"],
  hihi: ["smiling-face-with-smiling-eyes", "grinning-face", "face-with-hand-over-mouth", "beaming-face-with-smiling-eyes"],
  hehe: ["grinning-squinting-face", "smirking-face", "grinning-face"],
  kkk: ["rolling-on-the-floor-laughing", "face-with-tears-of-joy"],
  lol: ["rolling-on-the-floor-laughing", "face-with-tears-of-joy"],
  cuoi: ["face-with-tears-of-joy", "grinning-face", "rolling-on-the-floor-laughing"],
  "buon cuoi": ["face-with-tears-of-joy", "rolling-on-the-floor-laughing"],
  vui: ["beaming-face-with-smiling-eyes", "smiling-face-with-smiling-eyes", "partying-face", "star-struck"],
  "vui qua": ["partying-face", "star-struck", "beaming-face-with-smiling-eyes"],
  buon: ["loudly-crying-face", "crying-face", "pensive-face", "disappointed-face"],
  khoc: ["loudly-crying-face", "crying-face", "sad-but-relieved-face"],
  "huhu": ["loudly-crying-face", "crying-face"],
  tuc: ["pouting-face", "angry-face", "face-with-symbols-on-mouth"],
  gian: ["pouting-face", "angry-face", "face-with-symbols-on-mouth"],
  "buc minh": ["face-with-symbols-on-mouth", "pouting-face", "angry-face"],
  yeu: ["smiling-face-with-heart-eyes", "red-heart", "face-blowing-a-kiss", "smiling-face-with-hearts"],
  thuong: ["smiling-face-with-hearts", "red-heart", "hugging-face", "sparkling-heart"],
  "yeu thuong": ["smiling-face-with-hearts", "two-hearts", "red-heart"],
  "love": ["red-heart", "smiling-face-with-heart-eyes", "two-hearts"],
  "hun": ["face-blowing-a-kiss", "kissing-face-with-closed-eyes"],
  "thom": ["face-blowing-a-kiss", "kissing-face-with-closed-eyes"],
  "cam on": ["folded-hands", "smiling-face-with-hearts", "hugging-face", "red-heart"],
  "thank": ["folded-hands", "smiling-face-with-hearts"],
  "xin loi": ["person-bowing", "pleading-face", "folded-hands"],
  "sorry": ["person-bowing", "pleading-face"],
  ok: ["thumbs-up", "ok-hand", "check-mark-button"],
  oke: ["thumbs-up", "ok-hand", "check-mark-button"],
  okela: ["thumbs-up", "ok-hand"],
  "duoc": ["thumbs-up", "ok-hand", "check-mark-button"],
  "dong y": ["thumbs-up", "check-mark-button", "handshake"],
  "khong": ["thumbs-down", "cross-mark", "person-gesturing-no"],
  "hay qua": ["clapping-hands", "star-struck", "hundred-points", "fire"],
  "gioi qua": ["clapping-hands", "trophy", "hundred-points", "flexed-biceps"],
  "tuyet voi": ["star-struck", "clapping-hands", "hundred-points", "sparkles"],
  "dinh": ["fire", "hundred-points", "star-struck"],
  "chuc mung": ["party-popper", "partying-face", "confetti-ball", "clapping-hands"],
  "sinh nhat": ["birthday-cake", "partying-face", "wrapped-gift", "balloon"],
  "chao": ["waving-hand", "smiling-face-with-smiling-eyes", "grinning-face"],
  "xin chao": ["waving-hand", "smiling-face-with-smiling-eyes"],
  "hello": ["waving-hand", "grinning-face"],
  "hi": ["waving-hand", "grinning-face"],
  "bye": ["waving-hand", "hugging-face"],
  "tam biet": ["waving-hand", "hugging-face"],
  "chuc ngu ngon": ["sleeping-face", "crescent-moon", "zzz"],
  "ngu ngon": ["sleeping-face", "crescent-moon", "zzz"],
  "ngu": ["sleeping-face", "yawning-face", "zzz"],
  "buon ngu": ["yawning-face", "sleeping-face"],
  "met": ["weary-face", "tired-face", "yawning-face"],
  "doi": ["face-savoring-food", "steaming-bowl", "hamburger", "pizza"],
  "an com": ["steaming-bowl", "cooked-rice", "face-savoring-food"],
  "an gi": ["face-savoring-food", "steaming-bowl", "pizza"],
  "cafe": ["hot-beverage", "teacup-without-handle"],
  "ca phe": ["hot-beverage", "teacup-without-handle"],
  "tra sua": ["bubble-tea", "cup-with-straw"],
  "nhau": ["clinking-beer-mugs", "beer-mug"],
  "bia": ["beer-mug", "clinking-beer-mugs"],
  "ngac nhien": ["astonished-face", "exploding-head", "face-screaming-in-fear"],
  "wow": ["astonished-face", "star-struck", "exploding-head"],
  "troi oi": ["face-screaming-in-fear", "exploding-head", "astonished-face"],
  "so": ["face-screaming-in-fear", "fearful-face", "anxious-face-with-sweat"],
  "nghi": ["thinking-face", "face-with-monocle"],
  "suy nghi": ["thinking-face", "face-with-monocle"],
  "hmm": ["thinking-face", "face-with-raised-eyebrow"],
  "ngai": ["flushed-face", "smiling-face-with-smiling-eyes", "face-with-hand-over-mouth"],
  "xau ho": ["flushed-face", "see-no-evil-monkey"],
  "om": ["face-with-thermometer", "nauseated-face", "face-with-medical-mask"],
  "benh": ["face-with-thermometer", "face-with-medical-mask"],
  "nong": ["hot-face", "sun-with-face", "fire"],
  "lanh": ["cold-face", "snowflake"],
  "mua": ["cloud-with-rain", "umbrella-with-rain-drops"],
  "nang": ["sun-with-face", "sun"],
  "tien": ["money-bag", "money-with-wings", "dollar-banknote"],
  "luong": ["money-bag", "money-with-wings", "dollar-banknote"],
  "co len": ["flexed-biceps", "fire", "rocket"],
  "fighting": ["flexed-biceps", "fire"],
  "lam viec": ["laptop", "briefcase", "memo"],
  "hop": ["calendar", "memo", "briefcase"],
  "deadline": ["alarm-clock", "hourglass-not-done", "face-screaming-in-fear"],
  "nhanh len": ["rocket", "alarm-clock", "stopwatch"],
  "doi chut": ["hourglass-not-done", "stopwatch", "folded-hands"],
  "cho": ["hourglass-not-done", "stopwatch"],
  "meo": ["cat-face", "grinning-cat", "cat"],
  "cho con": ["dog-face", "dog"],
  "ca voi": ["spouting-whale", "whale"],
  "hoa": ["rose", "bouquet", "cherry-blossom", "sunflower"],
  "qua": ["wrapped-gift", "party-popper"],
  "tet": ["fireworks", "red-envelope", "party-popper"],
  "giang sinh": ["christmas-tree", "santa-claus", "wrapped-gift"],
  "noel": ["christmas-tree", "santa-claus", "wrapped-gift"],
  "dau long": ["broken-heart", "loudly-crying-face"],
  "bo tay": ["person-facepalming", "face-with-rolling-eyes", "person-shrugging"],
  "chiu": ["person-shrugging", "face-with-rolling-eyes"],
  "biet roi": ["ok-hand", "thumbs-up", "check-mark-button"],
  "im lang": ["zipper-mouth-face", "shushing-face"],
  "suyt": ["shushing-face", "zipper-mouth-face"],
  "ngau": ["smiling-face-with-sunglasses", "fire"],
  "dep": ["star-struck", "smiling-face-with-heart-eyes", "sparkles"],
  "vo tay": ["clapping-hands", "raising-hands"],
  "len": ["rocket", "flexed-biceps"],
};

const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

// longest phrases first ("buon cuoi" before "buon")
const VI_PHRASES = Object.keys(VI_KEYWORDS).sort((a, b) => b.length - a.length);
const hasPhrase = (text: string, phrase: string) => ` ${text} `.includes(` ${phrase} `);

/**
 * Stickers to offer for what is being typed, like Zalo: emoji in the text
 * first, then Vietnamese words, then English names/keywords. Short messages
 * only (up to 6 words); at most `limit`.
 */
export function suggestStickers(text: string, stickers: Sticker[], limit = 8): Sticker[] {
  const raw = text.trim();
  const t = fold(raw);
  const glyphs = raw.match(/\p{Extended_Pictographic}/gu) ?? [];
  if (!raw || (!glyphs.length && (!t || t.split(" ").length > 6))) return [];
  const byId = new Map(stickers.map((s) => [s.id, s]));
  const out: string[] = [];
  const add = (id: string) => {
    if (byId.has(id) && !out.includes(id)) out.push(id);
  };
  for (const g of glyphs) {
    const hit = stickers.find((s) => s.emoji && (s.emoji === g || s.emoji.replace(/️/g, "") === g));
    if (hit) add(hit.id);
  }
  if (t) {
    for (const phrase of VI_PHRASES) if (hasPhrase(t, phrase)) VI_KEYWORDS[phrase].forEach(add);
    if (t.split(" ").length <= 3) {
      for (const s of stickers) {
        if (out.length >= limit * 2) break;
        if (s.name === t || s.keywords.includes(t)) add(s.id);
      }
      for (const word of t.split(" ").filter((w) => w.length >= 4)) {
        for (const s of stickers) {
          if (out.length >= limit * 2) break;
          if (s.keywords.includes(word) || hasPhrase(s.name, word)) add(s.id);
        }
      }
    }
  }
  return out.slice(0, limit).map((id) => byId.get(id)!);
}

// stickers people reach for most (the Vietnamese suggestions, in order)
const POPULAR = [...new Set(Object.values(VI_KEYWORDS).flat())];
const RANK = new Map(POPULAR.map((id, i) => [id, i]));

/** Popular stickers first (laughing, hearts, thumbs up…), then the rest A–Z. */
export function byPopularity(stickers: Sticker[]): Sticker[] {
  return [...stickers].sort((a, b) => (RANK.get(a.id) ?? 1e6) - (RANK.get(b.id) ?? 1e6) || a.name.localeCompare(b.name));
}

/** The picker's search box: Vietnamese words, English names and keywords. */
export function searchStickers(query: string, stickers: Sticker[], limit = 120): Sticker[] {
  const q = fold(query);
  if (!q) return [];
  const out: Sticker[] = [];
  const seen = new Set<string>();
  const add = (s: Sticker | undefined) => {
    if (s && !seen.has(s.id)) {
      seen.add(s.id);
      out.push(s);
    }
  };
  const byId = new Map(stickers.map((s) => [s.id, s]));
  for (const phrase of VI_PHRASES) if (phrase.startsWith(q) || hasPhrase(phrase, q) || hasPhrase(q, phrase)) VI_KEYWORDS[phrase].forEach((id) => add(byId.get(id)));
  for (const s of stickers) if (s.name.includes(q) || s.keywords.some((k) => k.includes(q))) add(s);
  return out.slice(0, limit);
}
