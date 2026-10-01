import { createAdminClient } from "@/lib/supabase/admin";
import { UPLOADS_BUCKET } from "@/lib/storage";
import { isValidSuperAppName, superAppStoragePath } from "@/lib/superapp";
import { cacheHeadersFor, contentTypeFor } from "@/lib/superapp-delivery";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type FileMeta = { name: string; mime_type: string; size: number };

const NO_STORE = { "Cache-Control": "no-store" };

function textResponse(message: string, status: number): Response {
  return new Response(message, { status, headers: NO_STORE });
}

function fileHeaders(
  request: Request,
  meta: FileMeta,
  contentLength: number
): Headers {
  return new Headers({
    "Content-Type": contentTypeFor(meta.name, meta.mime_type),
    "Content-Length": String(contentLength),
    ...cacheHeadersFor(new URL(request.url)),
    // Keep "open the URL and the file downloads" in browsers, and never run
    // uploaded content as a page on this origin.
    "Content-Disposition": `attachment; filename="${meta.name}"`,
    "Content-Security-Policy": "sandbox; default-src 'none'",
  });
}

async function loadMeta(
  supabase: ReturnType<typeof createAdminClient>,
  name: string
): Promise<FileMeta | null> {
  const { data, error } = await supabase
    .from("superapp_files")
    .select("name, mime_type, size")
    .eq("name", name)
    .maybeSingle<FileMeta>();
  if (error) throw error;
  return data;
}

function isNotFound(error: unknown): boolean {
  const { status, statusCode } = error as {
    status?: number;
    statusCode?: string;
  };
  return status === 400 || status === 404 || statusCode === "404";
}

/**
 * Serves a file published through POST /api/superapp/files directly from
 * Supabase Storage (no redirect), with CDN-friendly cache headers.
 */
export async function GET(
  request: Request,
  { params }: RouteContext<"/superapp/[name]">
) {
  const { name } = await params;
  if (!isValidSuperAppName(name)) return textResponse("File not found.", 404);

  try {
    const supabase = createAdminClient();
    // Metadata and content are fetched in parallel to keep cold requests fast.
    const [meta, download] = await Promise.all([
      loadMeta(supabase, name),
      supabase.storage.from(UPLOADS_BUCKET).download(superAppStoragePath(name)),
    ]);
    if (!meta) return textResponse("File not found.", 404);
    if (download.error || !download.data) {
      if (download.error && !isNotFound(download.error)) {
        console.error("SuperApp file read failed", download.error);
        return textResponse("Unable to read the file.", 502);
      }
      return textResponse("File not found.", 404);
    }

    const body = download.data;
    return new Response(body, {
      status: 200,
      headers: fileHeaders(request, meta, body.size),
    });
  } catch (error) {
    console.error("SuperApp download failed", error);
    return textResponse("File downloads are unavailable.", 503);
  }
}

export async function HEAD(
  request: Request,
  { params }: RouteContext<"/superapp/[name]">
) {
  const { name } = await params;
  if (!isValidSuperAppName(name)) return textResponse("File not found.", 404);

  try {
    const meta = await loadMeta(createAdminClient(), name);
    if (!meta) return textResponse("File not found.", 404);
    return new Response(null, {
      status: 200,
      headers: fileHeaders(request, meta, Number(meta.size)),
    });
  } catch (error) {
    console.error("SuperApp head failed", error);
    return textResponse("File downloads are unavailable.", 503);
  }
}
