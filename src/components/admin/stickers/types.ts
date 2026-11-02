import type { CustomSticker, StickerPack } from "@/lib/stickers/custom";

/** A pack as Admin → Stickers holds it: the row plus its stickers in order. */
export type AdminPack = StickerPack & { stickers: CustomSticker[] };

/** The sticker that represents a pack: its cover, else its first sticker. */
export function packIconId(pack: AdminPack): string | null {
  const cover = pack.cover_sticker_id && pack.stickers.some((s) => s.id === pack.cover_sticker_id);
  return cover ? pack.cover_sticker_id : (pack.stickers[0]?.id ?? null);
}

/** Pack names are 1–60 characters once trimmed; null when fine. */
export function packNameProblem(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "Enter a pack name";
  if (trimmed.length > 60) return "Use at most 60 characters";
  return null;
}
