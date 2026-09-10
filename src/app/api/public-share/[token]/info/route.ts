import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: RouteContext<"/api/public-share/[token]/info">
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
      return NextResponse.json({ error: "Share link not found" }, { status: 404 });
    }
    if (link.disabled) {
      return NextResponse.json({ error: "This share link has been disabled" }, { status: 410 });
    }
    if (link.expires_at && new Date(link.expires_at) <= new Date()) {
      return NextResponse.json({ error: "This share link has expired" }, { status: 410 });
    }
    if (!link.allow_download) {
      return NextResponse.json({ error: "Downloads are disabled for this link" }, { status: 403 });
    }

    const { data: file, error: fileError } = await supabase
      .from("files")
      .select("id, name, size, mime_type, updated_at, deleted_at")
      .eq("id", link.file_id)
      .maybeSingle();

    if (fileError || !file || file.deleted_at) {
      return NextResponse.json({ error: "The shared file is no longer available" }, { status: 404 });
    }

    return NextResponse.json({
      name: file.name,
      size: file.size,
      mimeType: file.mime_type,
      updatedAt: file.updated_at,
      requiresPassword: Boolean(link.password_hash),
    });
  } catch (error) {
    console.error("Fetch shared file info failed", error);
    return NextResponse.json({ error: "Failed to fetch file info" }, { status: 500 });
  }
}
