import { after, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { UPLOADS_BUCKET } from "@/lib/storage";
import { lookupShareLink, NO_STORE_HEADERS } from "@/lib/public-share";

export const dynamic = "force-dynamic";

const SIGNED_URL_TTL_SECONDS = 60;

const INACTIVE_LINK_RESPONSES = {
  not_found: ["Share link not found.", 404],
  disabled: ["This share link has been disabled.", 410],
  expired: ["This share link has expired.", 410],
} as const;

function textResponse(message: string, status: number) {
  return new NextResponse(message, { status, headers: NO_STORE_HEADERS });
}

/**
 * Downloads the current version of a file shared through a public link.
 * The storage bucket remains private: possession of a valid, active link is
 * required to receive a short-lived signed URL.
 */
export async function GET(
  _request: Request,
  { params }: RouteContext<"/api/public-share/[token]">
) {
  const { token } = await params;

  try {
    const supabase = createAdminClient();
    const lookup = await lookupShareLink(supabase, token);

    if (lookup.status !== "active") {
      const [message, status] = INACTIVE_LINK_RESPONSES[lookup.status];
      return textResponse(message, status);
    }
    const { link } = lookup;
    if (link.password_hash) {
      return textResponse("This share link requires a password.", 403);
    }
    if (!link.allow_download) {
      return textResponse("Downloads are disabled for this share link.", 403);
    }

    const { data: file, error: fileError } = await supabase
      .from("files")
      .select("id, name, current_version_id, deleted_at")
      .eq("id", link.file_id)
      .maybeSingle();

    if (fileError || !file || file.deleted_at || !file.current_version_id) {
      return textResponse("The shared file is no longer available.", 404);
    }

    const { data: version, error: versionError } = await supabase
      .from("file_versions")
      .select("storage_path")
      .eq("id", file.current_version_id)
      .maybeSingle();

    if (versionError || !version) {
      return textResponse("The shared file is no longer available.", 404);
    }

    const { data: signedUrl, error: signedUrlError } = await supabase.storage
      .from(UPLOADS_BUCKET)
      .createSignedUrl(version.storage_path, SIGNED_URL_TTL_SECONDS, {
        download: file.name,
      });

    if (signedUrlError || !signedUrl) {
      return textResponse("Unable to prepare the download.", 500);
    }

    // Record usage without delaying the download.
    after(async () => {
      const { error } = await supabase
        .from("share_links")
        .update({ last_used_at: new Date().toISOString() })
        .eq("id", link.id);
      if (error) console.error("Failed to record share link usage", error);
    });

    const response = NextResponse.redirect(signedUrl.signedUrl);
    response.headers.set("Cache-Control", NO_STORE_HEADERS["Cache-Control"]);
    return response;
  } catch (error) {
    console.error("Public share download failed", error);
    return textResponse("Public file sharing is unavailable.", 503);
  }
}
