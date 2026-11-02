import { createClient } from "@/lib/supabase/client";
import { getErrorMessage } from "@/lib/types/database";

// The sticker catalog every signed-in user sees in chat: custom packs that
// site admins enabled (202608280044_custom_stickers.sql) and the built-in
// groups they hid. Read-only (RLS table selects).

export type StickerCatalog = {
  packs: {
    id: string;
    name: string;
    cover_sticker_id: string | null;
    stickers: { id: string; name: string; keywords: string[] }[];
  }[];
  hiddenGroups: string[];
};

/** PostgREST returns at most 1000 rows per request (Supabase default). */
const PAGE = 1000;

/** Every row of a paged query (`page(from, to)` must be ordered). */
export async function allRows<T>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>
): Promise<{ data: T[]; error: unknown }> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1);
    if (error) return { data: rows, error };
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE) return { data: rows, error: null };
  }
}

/** The tables or the migration are not there (yet). */
function isMissing(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return (
    code === "PGRST202" ||
    code === "PGRST205" ||
    code === "42P01" ||
    /could not find the (function|table)/i.test(getErrorMessage(error))
  );
}

/**
 * Enabled packs that have stickers, with their stickers in display order,
 * and the hidden built-in group keys. Returns an empty catalog when the migration is not
 * applied, so chat keeps its built-in stickers; other errors (network, auth)
 * are thrown.
 */
export async function getStickerCatalog(): Promise<StickerCatalog> {
  const supabase = createClient();
  const [packs, stickers, hidden] = await Promise.all([
    supabase
      .from("sticker_packs")
      .select("id, name, cover_sticker_id")
      .eq("enabled", true)
      .order("sort_order")
      .order("created_at"),
    allRows<{ id: string; pack_id: string; name: string; keywords: string[] | null }>((from, to) =>
      supabase
        .from("custom_stickers")
        .select("id, pack_id, name, keywords")
        .order("sort_order")
        .order("created_at")
        .order("id")
        .range(from, to)
    ),
    supabase.from("sticker_hidden_groups").select("group_key"),
  ]);
  for (const result of [packs, stickers, hidden]) {
    if (result.error) {
      if (isMissing(result.error)) return { packs: [], hiddenGroups: [] };
      throw new Error(getErrorMessage(result.error));
    }
  }

  const byPack = new Map<string, { id: string; name: string; keywords: string[] }[]>();
  for (const s of stickers.data) {
    const sticker = { id: s.id, name: s.name, keywords: s.keywords ?? [] };
    const list = byPack.get(s.pack_id);
    if (list) list.push(sticker);
    else byPack.set(s.pack_id, [sticker]);
  }
  return {
    // a site admin also reads the stickers of disabled packs; they are dropped with their pack
    packs: ((packs.data ?? []) as { id: string; name: string; cover_sticker_id: string | null }[])
      .map((p) => ({ id: p.id, name: p.name, cover_sticker_id: p.cover_sticker_id, stickers: byPack.get(p.id) ?? [] }))
      .filter((p) => p.stickers.length > 0),
    hiddenGroups: ((hidden.data ?? []) as { group_key: string }[]).map((row) => row.group_key),
  };
}
