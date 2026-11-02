// Custom stickers that site admins upload (Admin → Stickers). Each one is an
// object in the public "stickers" bucket named exactly like its id, so any
// message can show it from the id alone. Pure helpers, no Supabase calls.

export const CUSTOM_PREFIX = "cs-";
const CUSTOM_ID = /^cs-[a-z0-9]{10}$/;

/** largest sticker image (animated GIF/WebP included); the bucket enforces it too */
export const STICKER_MAX_BYTES = 2 * 1024 * 1024;
/** browsers may keep a sticker picture this long, so a deleted one disappears within an hour */
export const STICKER_CACHE_SECONDS = "3600";
export const STICKER_MIME = ["image/png", "image/webp", "image/gif", "image/jpeg"] as const;
export type StickerMime = (typeof STICKER_MIME)[number];

export const PACK_NAME_MAX = 60;
export const STICKER_NAME_MAX = 60;
export const KEYWORDS_MAX = 30;
export const KEYWORD_MAX = 40;

export type StickerPack = {
  id: string;
  name: string;
  cover_sticker_id: string | null;
  sort_order: number;
  enabled: boolean;
  created_at: string;
  updated_at: string;
};

export type CustomSticker = {
  id: string;
  pack_id: string;
  name: string;
  keywords: string[];
  sort_order: number;
  mime: StickerMime;
  size_bytes: number;
  created_at: string;
};

/** Optional pack.json inside an imported ZIP. */
export type PackManifest = {
  name?: string;
  stickers?: { file: string; name?: string; keywords?: string[] }[];
};

/** At most `max` characters, never splitting an emoji (String.slice counts UTF-16 units). */
function clip(text: string, max: number): string {
  return Array.from(text).slice(0, max).join("").trim();
}

export function isCustomStickerId(id: string): boolean {
  return CUSTOM_ID.test(id);
}

export function newCustomStickerId(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return CUSTOM_PREFIX + Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

export function customStickerUrl(id: string): string {
  const base = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/\/+$/, "");
  return `${base}/storage/v1/object/public/stickers/${id}`;
}

/** "Vui, vui vẻ\nhaha" → ["vui", "vui vẻ", "haha"]: trimmed, lower case, no duplicates, capped. */
export function normalizeKeywords(input: string | readonly string[]): string[] {
  const parts = typeof input === "string" ? input.split(/[,;\n]/) : input.flatMap((k) => k.split(/[,;\n]/));
  const out: string[] = [];
  for (const part of parts) {
    const cleaned = part.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
    const word = clip(cleaned, KEYWORD_MAX);
    if (word && !out.includes(word)) out.push(word);
    if (out.length === KEYWORDS_MAX) break;
  }
  return out;
}

/** The image type from the file's first bytes (never trust the name or the header). */
export function sniffImageMime(bytes: Uint8Array): StickerMime | null {
  const at = (i: number, ...sig: number[]) => sig.every((b, k) => bytes[i + k] === b);
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (at(0, 0x47, 0x49, 0x46, 0x38) && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) return "image/gif";
  if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
  return null;
}

/** "happy_cat-01.png" → "happy cat 01" */
export function stickerNameFromFile(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? fileName;
  const name = base.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  return clip(name, STICKER_NAME_MAX) || "Sticker";
}

/** Reads pack.json leniently: unknown fields are ignored, bad entries dropped; null when unusable. */
export function parsePackManifest(json: unknown): PackManifest | null {
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;
  const raw = json as { name?: unknown; stickers?: unknown };
  const manifest: PackManifest = {};
  if (typeof raw.name === "string" && raw.name.trim()) manifest.name = clip(raw.name, PACK_NAME_MAX);
  if (Array.isArray(raw.stickers)) {
    manifest.stickers = raw.stickers.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const e = entry as { file?: unknown; name?: unknown; keywords?: unknown };
      if (typeof e.file !== "string" || !e.file.trim()) return [];
      const keywords =
        typeof e.keywords === "string" || (Array.isArray(e.keywords) && e.keywords.every((k) => typeof k === "string"))
          ? normalizeKeywords(e.keywords as string | string[])
          : undefined;
      return [
        {
          file: e.file.trim(),
          ...(typeof e.name === "string" && e.name.trim() ? { name: clip(e.name, STICKER_NAME_MAX) } : {}),
          ...(keywords?.length ? { keywords } : {}),
        },
      ];
    });
  }
  return manifest;
}
