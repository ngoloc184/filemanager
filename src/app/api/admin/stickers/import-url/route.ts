import { NextResponse, type NextRequest } from "next/server";
import { createRateLimiter } from "@/lib/assistant/rate-limit";
import { isSameOriginPost, requestOrigin } from "@/lib/auth-links";
import { SafeFetchError, fetchImageSafely } from "@/lib/net/safe-fetch";
import {
  KEYWORDS_MAX,
  STICKER_CACHE_SECONDS,
  STICKER_NAME_MAX,
  newCustomStickerId,
  normalizeKeywords,
  stickerNameFromFile,
  type CustomSticker,
} from "@/lib/stickers/custom";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BUCKET = "stickers";
const STICKER_COLUMNS = "id, pack_id, name, keywords, sort_order, mime, size_bytes, created_at";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** per admin and server instance: this route makes outgoing requests */
const allow = createRateLimiter(30, 60_000);

const json = (body: CustomSticker | { error: string }, status = 200) =>
  NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

type ImportInput = { packId: string; url: string; name: string | null; keywords: string[] };

function parseInput(body: unknown): ImportInput | { error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "Invalid request" };
  const raw = body as { packId?: unknown; url?: unknown; name?: unknown; keywords?: unknown };
  if (typeof raw.packId !== "string" || !UUID.test(raw.packId)) return { error: "Choose a sticker pack." };
  if (typeof raw.url !== "string" || !raw.url.trim()) return { error: "Enter an image link." };
  if (raw.name !== undefined && raw.name !== null && typeof raw.name !== "string") return { error: "Invalid sticker name." };
  const keywords = raw.keywords ?? [];
  if (typeof keywords !== "string" && !(Array.isArray(keywords) && keywords.every((k) => typeof k === "string"))) {
    return { error: "Invalid keywords." };
  }
  // cut by characters (code points), never inside an emoji
  const name =
    typeof raw.name === "string" ? Array.from(raw.name.trim().replace(/\s+/g, " ")).slice(0, STICKER_NAME_MAX).join("").trim() : "";
  return {
    packId: raw.packId,
    url: raw.url.trim(),
    name: name || null,
    keywords: normalizeKeywords(keywords as string | string[]).slice(0, KEYWORDS_MAX),
  };
}

/** "https://x.com/img/happy_cat.png?s=1" → "happy cat" */
function nameFromUrl(url: string): string {
  try {
    const last = new URL(url).pathname.split("/").filter(Boolean).pop() ?? "";
    return stickerNameFromFile(decodeURIComponent(last));
  } catch {
    return "Sticker";
  }
}

/**
 * POST /api/admin/stickers/import-url {packId, url, name?, keywords?}
 *
 * A site admin adds a sticker from an image link: the server downloads it
 * (src/lib/net/safe-fetch.ts: https only, public addresses, at most 2 MB,
 * PNG/WebP/GIF/JPEG by its bytes), stores it as the admin (storage policies
 * and RLS apply, no service role) and returns the new CustomSticker.
 */
export async function POST(request: NextRequest) {
  if (!isSameOriginPost(request.headers, requestOrigin(request.headers, request.nextUrl.origin))) {
    return json({ error: "Forbidden" }, 403);
  }
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return json({ error: "Unauthorized" }, 401);
  // before reading the body: everyone else is refused without it
  const admin = await supabase.rpc("is_app_admin");
  if (admin.error || admin.data !== true) return json({ error: "Only site admins can manage stickers." }, 403);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid request" }, 400);
  }
  const input = parseInput(body);
  if ("error" in input) return json(input, 400);
  if (!allow(user.id)) return json({ error: "Too many imports. Wait a minute and try again." }, 429);

  const pack = await supabase.from("sticker_packs").select("id").eq("id", input.packId).maybeSingle();
  if (pack.error) {
    console.error("sticker import: pack lookup failed", pack.error.code);
    return json({ error: "Could not import the image. Please try again." }, 500);
  }
  if (!pack.data) return json({ error: "This pack no longer exists." }, 404);

  let image: Awaited<ReturnType<typeof fetchImageSafely>>;
  try {
    image = await fetchImageSafely(input.url);
  } catch (err) {
    if (err instanceof SafeFetchError) return json({ error: err.message }, err.status);
    console.error("sticker import: download failed", err instanceof Error ? err.name : "error");
    return json({ error: "Could not download the image." }, 502);
  }

  const last = await supabase
    .from("custom_stickers")
    .select("sort_order")
    .eq("pack_id", input.packId)
    .order("sort_order", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (last.error) {
    console.error("sticker import: order lookup failed", last.error.code);
    return json({ error: "Could not import the image. Please try again." }, 500);
  }

  const id = newCustomStickerId();
  const uploaded = await supabase.storage
    .from(BUCKET)
    .upload(id, image.bytes, { contentType: image.mime, cacheControl: STICKER_CACHE_SECONDS, upsert: false });
  if (uploaded.error) {
    console.error("sticker import: upload failed", uploaded.error.message);
    return json({ error: "Could not store the image. Please try again." }, 500);
  }

  const { data, error } = await supabase
    .from("custom_stickers")
    .insert({
      id,
      pack_id: input.packId,
      name: input.name ?? nameFromUrl(input.url),
      keywords: input.keywords,
      sort_order: ((last.data as { sort_order: number } | null)?.sort_order ?? -1) + 1,
      mime: image.mime,
      size_bytes: image.bytes.byteLength,
    })
    .select(STICKER_COLUMNS)
    .single();
  if (error) {
    await supabase.storage.from(BUCKET).remove([id]).catch(() => undefined);
    if (error.code === "23503") return json({ error: "This pack no longer exists." }, 404);
    console.error("sticker import: insert failed", error.code);
    return json({ error: "Could not import the image. Please try again." }, 500);
  }
  return json(data as CustomSticker);
}
