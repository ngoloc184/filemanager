import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { UPLOADS_BUCKET } from "@/lib/services/files";

export const dynamic = "force-dynamic";

const SIGNED_URL_TTL_SECONDS = 60;

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
    const { data: link, error: linkError } = await supabase
      .from("share_links")
      .select("id, file_id, password_hash, allow_download, expires_at, disabled")
      .eq("token", token)
      .maybeSingle();

    if (linkError || !link?.file_id) {
      return new NextResponse("Share link not found.", { status: 404 });
    }
    if (link.disabled) {
      return new NextResponse("This share link has been disabled.", { status: 410 });
    }
    if (link.expires_at && new Date(link.expires_at) <= new Date()) {
      return new NextResponse("This share link has expired.", { status: 410 });
    }
    if (link.password_hash) {
      return new NextResponse("This share link requires a password.", { status: 403 });
    }
    if (!link.allow_download) {
      return new NextResponse("Downloads are disabled for this share link.", {
        status: 403,
      });
    }

    const { data: file, error: fileError } = await supabase
      .from("files")
      .select("id, name, current_version_id, deleted_at")
      .eq("id", link.file_id)
      .maybeSingle();

    if (fileError || !file || file.deleted_at || !file.current_version_id) {
      return new NextResponse("The shared file is no longer available.", {
        status: 404,
      });
    }

    const { data: version, error: versionError } = await supabase
      .from("file_versions")
      .select("storage_path")
      .eq("id", file.current_version_id)
      .maybeSingle();

    if (versionError || !version) {
      return new NextResponse("The shared file is no longer available.", {
        status: 404,
      });
    }

    const { data: signedUrl, error: signedUrlError } = await supabase.storage
      .from(UPLOADS_BUCKET)
      .createSignedUrl(version.storage_path, SIGNED_URL_TTL_SECONDS, {
        download: file.name,
      });

    if (signedUrlError || !signedUrl) {
      return new NextResponse("Unable to prepare the download.", { status: 500 });
    }

    void supabase
      .from("share_links")
      .update({ last_used_at: new Date().toISOString() })
      .eq("id", link.id);

    return NextResponse.redirect(signedUrl.signedUrl);
  } catch (error) {
    console.error("Public share download failed", error);
    return new NextResponse("Public file sharing is unavailable.", { status: 503 });
  }
}
