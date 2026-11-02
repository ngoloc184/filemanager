import { createClient } from "@/lib/supabase/client";
import { allRows } from "@/lib/services/stickers";
import { getErrorMessage } from "@/lib/types/database";
import {
  KEYWORDS_MAX,
  PACK_NAME_MAX,
  STICKER_CACHE_SECONDS,
  STICKER_MAX_BYTES,
  STICKER_NAME_MAX,
  newCustomStickerId,
  normalizeKeywords,
  sniffImageMime,
  type CustomSticker,
  type StickerPack,
} from "@/lib/stickers/custom";

// Admin → Stickers: packs, their stickers and the hidden built-in groups.
// Writes are plain table writes and storage uploads; RLS and the storage
// policies of 202608280044_custom_stickers.sql allow them for site admins only.

export const STICKERS_BUCKET = "stickers";
const PACK_COLUMNS = "id, name, cover_sticker_id, sort_order, enabled, created_at, updated_at";
const STICKER_COLUMNS = "id, pack_id, name, keywords, sort_order, mime, size_bytes, created_at";
/** objects per Storage remove call */
const REMOVE_BATCH = 100;

export type AdminStickerPack = StickerPack & { stickers: CustomSticker[] };

/** Explains a missing migration or a refused write instead of PostgREST's raw error. */
function stickersError(error: unknown): Error {
  const code = (error as { code?: string } | null)?.code;
  const message = getErrorMessage(error);
  if (code === "PGRST202" || code === "PGRST205" || code === "42P01" || /could not find the (function|table)/i.test(message)) {
    return new Error("Custom stickers are not set up yet. Run migration 202608280044_custom_stickers.sql.");
  }
  if (code === "42501" || /row-level security|permission denied/i.test(message)) {
    return new Error("Only site admins can manage stickers.");
  }
  return new Error(message);
}

// lengths in characters (code points), as the database's char_length counts
// them: an emoji is one, and a cut never splits it in half

function packName(name: string): string {
  const value = name.trim().replace(/\s+/g, " ");
  if (!value) throw new Error("Give the pack a name.");
  if (Array.from(value).length > PACK_NAME_MAX) throw new Error(`A pack name can have at most ${PACK_NAME_MAX} characters.`);
  return value;
}

function stickerName(name: string): string {
  const value = name.trim().replace(/\s+/g, " ");
  if (!value) throw new Error("Give the sticker a name.");
  return Array.from(value).slice(0, STICKER_NAME_MAX).join("").trim();
}

// ---------------------------------------------------------------- packs

/** Every pack (disabled ones too) with its stickers, in display order. */
export async function listPacksAdmin(): Promise<AdminStickerPack[]> {
  const supabase = createClient();
  const [packs, stickers] = await Promise.all([
    supabase.from("sticker_packs").select(PACK_COLUMNS).order("sort_order").order("created_at"),
    allRows<CustomSticker>((from, to) =>
      supabase.from("custom_stickers").select(STICKER_COLUMNS).order("sort_order").order("created_at").order("id").range(from, to)
    ),
  ]);
  if (packs.error) throw stickersError(packs.error);
  if (stickers.error) throw stickersError(stickers.error);
  const byPack = new Map<string, CustomSticker[]>();
  for (const sticker of stickers.data) {
    const list = byPack.get(sticker.pack_id);
    if (list) list.push(sticker);
    else byPack.set(sticker.pack_id, [sticker]);
  }
  return ((packs.data ?? []) as StickerPack[]).map((pack) => ({ ...pack, stickers: byPack.get(pack.id) ?? [] }));
}

/** A new, enabled pack placed after the others. */
export async function createPack(name: string): Promise<StickerPack> {
  const supabase = createClient();
  const last = await supabase
    .from("sticker_packs")
    .select("sort_order")
    .order("sort_order", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (last.error) throw stickersError(last.error);
  const { data, error } = await supabase
    .from("sticker_packs")
    .insert({ name: packName(name), sort_order: ((last.data as { sort_order: number } | null)?.sort_order ?? -1) + 1 })
    .select(PACK_COLUMNS)
    .single();
  if (error) throw stickersError(error);
  return data as StickerPack;
}

export async function updatePack(
  id: string,
  patch: Partial<Pick<StickerPack, "name" | "cover_sticker_id" | "enabled">>
): Promise<StickerPack> {
  const changes: Partial<Pick<StickerPack, "name" | "cover_sticker_id" | "enabled">> = {};
  if (patch.name !== undefined) changes.name = packName(patch.name);
  if (patch.cover_sticker_id !== undefined) changes.cover_sticker_id = patch.cover_sticker_id;
  if (patch.enabled !== undefined) changes.enabled = patch.enabled;
  const { data, error } = await createClient()
    .from("sticker_packs")
    .update(changes)
    .eq("id", id)
    .select(PACK_COLUMNS)
    .maybeSingle();
  if (error) {
    if ((error as { code?: string }).code === "23503") throw new Error("The cover must be a sticker of this pack.");
    throw stickersError(error);
  }
  if (!data) throw new Error("This pack no longer exists.");
  return data as StickerPack;
}

/** Removes the pack's images, then the pack (its stickers go with it). */
export async function deletePack(id: string): Promise<void> {
  const supabase = createClient();
  const { data, error } = await allRows<{ id: string }>((from, to) =>
    supabase.from("custom_stickers").select("id").eq("pack_id", id).order("id").range(from, to)
  );
  if (error) throw stickersError(error);
  const ids = data.map((row) => row.id);
  for (let i = 0; i < ids.length; i += REMOVE_BATCH) {
    const removed = await supabase.storage.from(STICKERS_BUCKET).remove(ids.slice(i, i + REMOVE_BATCH));
    if (removed.error) throw stickersError(removed.error);
  }
  const deleted = await supabase.from("sticker_packs").delete().eq("id", id);
  if (deleted.error) throw stickersError(deleted.error);
}

/** Packs in this order (sort_order = position); packs not listed keep theirs. */
export async function reorderPacks(ids: string[]): Promise<void> {
  const { error } = await createClient().rpc("reorder_sticker_packs", { p_ids: ids });
  if (error) throw stickersError(error);
}

// ---------------------------------------------------------------- stickers

/**
 * Checks the image, stores it as `stickers/<new id>` and adds the sticker at
 * the end of the pack. The stored image is removed again when the row cannot
 * be added.
 */
export async function uploadSticker(
  packId: string,
  input: { bytes: Uint8Array; name: string; keywords: string[] }
): Promise<CustomSticker> {
  if (input.bytes.byteLength === 0) throw new Error("The image is empty.");
  if (input.bytes.byteLength > STICKER_MAX_BYTES) throw new Error("A sticker can be at most 2 MB.");
  const mime = sniffImageMime(input.bytes);
  if (!mime) throw new Error("Only PNG, WebP, GIF and JPEG images can be stickers.");
  const name = stickerName(input.name);
  const keywords = normalizeKeywords(input.keywords).slice(0, KEYWORDS_MAX);

  const supabase = createClient();
  const last = await supabase
    .from("custom_stickers")
    .select("sort_order")
    .eq("pack_id", packId)
    .order("sort_order", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (last.error) throw stickersError(last.error);
  const sortOrder = ((last.data as { sort_order: number } | null)?.sort_order ?? -1) + 1;

  const id = newCustomStickerId();
  const uploaded = await supabase.storage
    .from(STICKERS_BUCKET)
    .upload(id, input.bytes, { contentType: mime, cacheControl: STICKER_CACHE_SECONDS, upsert: false });
  if (uploaded.error) throw stickersError(uploaded.error);

  const { data, error } = await supabase
    .from("custom_stickers")
    .insert({ id, pack_id: packId, name, keywords, sort_order: sortOrder, mime, size_bytes: input.bytes.byteLength })
    .select(STICKER_COLUMNS)
    .single();
  if (error) {
    await supabase.storage.from(STICKERS_BUCKET).remove([id]).catch(() => undefined);
    if ((error as { code?: string }).code === "23503") throw new Error("This pack no longer exists.");
    throw stickersError(error);
  }
  return data as CustomSticker;
}

export async function updateSticker(id: string, patch: { name?: string; keywords?: string[] }): Promise<CustomSticker> {
  const changes: { name?: string; keywords?: string[] } = {};
  if (patch.name !== undefined) changes.name = stickerName(patch.name);
  if (patch.keywords !== undefined) changes.keywords = normalizeKeywords(patch.keywords).slice(0, KEYWORDS_MAX);
  const { data, error } = await createClient()
    .from("custom_stickers")
    .update(changes)
    .eq("id", id)
    .select(STICKER_COLUMNS)
    .maybeSingle();
  if (error) throw stickersError(error);
  if (!data) throw new Error("This sticker no longer exists.");
  return data as CustomSticker;
}

/**
 * Deletes the sticker, then its image. A pack whose cover it was loses the
 * cover (the foreign key clears cover_sticker_id). Old messages then show a
 * placeholder.
 */
export async function deleteSticker(id: string): Promise<void> {
  const supabase = createClient();
  const { error } = await supabase.from("custom_stickers").delete().eq("id", id);
  if (error) throw stickersError(error);
  const removed = await supabase.storage.from(STICKERS_BUCKET).remove([id]);
  if (removed.error) throw new Error("The sticker was deleted, but its image could not be removed from storage.");
}

/** Stickers of a pack in this order (sort_order = position). */
export async function reorderStickers(packId: string, ids: string[]): Promise<void> {
  const { error } = await createClient().rpc("reorder_custom_stickers", { p_pack_id: packId, p_ids: ids });
  if (error) throw stickersError(error);
}

/** The server downloads the image (https only, public addresses, at most 2 MB) and adds it to the pack. */
export async function importStickerFromUrl(
  packId: string,
  url: string,
  input?: { name?: string; keywords?: string[] }
): Promise<CustomSticker> {
  let response: Response;
  try {
    response = await fetch("/api/admin/stickers/import-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ packId, url, name: input?.name, keywords: input?.keywords }),
    });
  } catch {
    throw new Error("Could not reach the server. Check your connection and try again.");
  }
  const body = (await response.json().catch(() => null)) as (CustomSticker & { error?: string }) | null;
  if (!response.ok || !body || body.error) {
    throw new Error(body?.error || "Could not import the image. Please try again.");
  }
  return body;
}

// ---------------------------------------------------------------- built-in groups

/** Keys of the built-in (Fluent) groups hidden from the picker. */
export async function listHiddenGroups(): Promise<string[]> {
  const { data, error } = await createClient().from("sticker_hidden_groups").select("group_key").order("group_key");
  if (error) throw stickersError(error);
  return ((data ?? []) as { group_key: string }[]).map((row) => row.group_key);
}

export async function setGroupHidden(groupKey: string, hidden: boolean): Promise<void> {
  const table = createClient().from("sticker_hidden_groups");
  const { error } = hidden
    ? await table.upsert({ group_key: groupKey }, { onConflict: "group_key", ignoreDuplicates: true })
    : await table.delete().eq("group_key", groupKey);
  if (error) throw stickersError(error);
}
