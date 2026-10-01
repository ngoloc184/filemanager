import { createAdminClient } from "@/lib/supabase/admin";
import { UPLOADS_BUCKET } from "@/lib/storage";
import { isValidSuperAppName, superAppStoragePath } from "@/lib/superapp";
import {
  cacheHeadersFor,
  contentTypeFor,
  requestedVersion,
} from "@/lib/superapp-delivery";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type FileMeta = {
  name: string;
  version: string | null;
  storage_path: string;
  mime_type: string;
  size: number;
};
type AdminClient = ReturnType<typeof createAdminClient>;
/** `exact` means the snapshot of the requested version was found. */
type ResolvedFile = { meta: FileMeta; exact: boolean };

const META_COLUMNS = "name, version, storage_path, mime_type, size";
const NO_STORE = { "Cache-Control": "no-store" };

function textResponse(message: string, status: number): Response {
  return new Response(message, { status, headers: NO_STORE });
}

function fileHeaders(file: ResolvedFile, contentLength: number): Headers {
  return new Headers({
    "Content-Type": contentTypeFor(file.meta.name, file.meta.mime_type),
    "Content-Length": String(contentLength),
    ...cacheHeadersFor(file.exact),
    // Which snapshot was served, so clients can detect a fallback.
    "X-SuperApp-Version": file.meta.version ?? "unversioned",
    // Keep "open the URL and the file downloads" in browsers, and never run
    // uploaded content as a page on this origin.
    "Content-Disposition": `attachment; filename="${file.meta.name}"`,
    "Content-Security-Policy": "sandbox; default-src 'none'",
  });
}

async function findExact(
  supabase: AdminClient,
  name: string,
  version: string
): Promise<FileMeta | null> {
  const { data, error } = await supabase
    .from("superapp_files")
    .select(META_COLUMNS)
    .eq("name", name)
    .eq("version", version)
    .maybeSingle<FileMeta>();
  if (error) throw error;
  return data;
}

/**
 * Content served when no exact snapshot matches:
 * - with `?v=`: only the unversioned (legacy) upload, never another version;
 * - without `v`: the most recently uploaded copy of the file.
 */
async function findFallback(
  supabase: AdminClient,
  name: string,
  versionRequested: boolean
): Promise<FileMeta | null> {
  const query = supabase
    .from("superapp_files")
    .select(META_COLUMNS)
    .eq("name", name);
  const { data, error } = await (versionRequested
    ? query.is("version", null)
    : query.order("updated_at", { ascending: false }).limit(1)
  ).maybeSingle<FileMeta>();
  if (error) throw error;
  return data;
}

async function resolveFile(
  supabase: AdminClient,
  name: string,
  version: string | null,
  exactMeta?: FileMeta | null
): Promise<ResolvedFile | null> {
  if (version) {
    const meta = exactMeta ?? (await findExact(supabase, name, version));
    if (meta) return { meta, exact: true };
  }
  const meta = await findFallback(supabase, name, version !== null);
  return meta ? { meta, exact: false } : null;
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
 * Supabase Storage (no redirect). `?v=<version>` selects that version's
 * snapshot; only an exact match is cached as immutable.
 */
export async function GET(
  request: Request,
  { params }: RouteContext<"/superapp/[name]">
) {
  const { name } = await params;
  if (!isValidSuperAppName(name)) return textResponse("File not found.", 404);
  const version = requestedVersion(new URL(request.url));

  try {
    const supabase = createAdminClient();
    const storage = supabase.storage.from(UPLOADS_BUCKET);

    // Common case: fetch the versioned snapshot's metadata and content in
    // parallel to keep cold requests fast.
    let file: ResolvedFile | null;
    let download: Awaited<ReturnType<typeof storage.download>> | null = null;
    if (version) {
      const [exactMeta, exactDownload] = await Promise.all([
        findExact(supabase, name, version),
        storage.download(superAppStoragePath(name, version)),
      ]);
      file = await resolveFile(supabase, name, version, exactMeta);
      if (file?.exact) download = exactDownload;
    } else {
      file = await resolveFile(supabase, name, null);
    }
    if (!file) return textResponse("File not found.", 404);

    download ??= await storage.download(file.meta.storage_path);
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
      headers: fileHeaders(file, body.size),
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
  const version = requestedVersion(new URL(request.url));

  try {
    const file = await resolveFile(createAdminClient(), name, version);
    if (!file) return textResponse("File not found.", 404);
    return new Response(null, {
      status: 200,
      headers: fileHeaders(file, Number(file.meta.size)),
    });
  } catch (error) {
    console.error("SuperApp head failed", error);
    return textResponse("File downloads are unavailable.", 503);
  }
}
