import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { lookupShareLink, NO_STORE_HEADERS } from "@/lib/public-share";

export const dynamic = "force-dynamic";

const INACTIVE_LINK_RESPONSES = {
  not_found: ["Share link not found", 404],
  disabled: ["This share link has been disabled", 410],
  expired: ["This share link has expired", 410],
} as const;

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, { status, headers: NO_STORE_HEADERS });
}

export async function GET(
  _request: Request,
  { params }: RouteContext<"/api/public-share/[token]/info">
) {
  const { token } = await params;

  try {
    const supabase = createAdminClient();
    const lookup = await lookupShareLink(supabase, token);

    if (lookup.status !== "active") {
      const [error, status] = INACTIVE_LINK_RESPONSES[lookup.status];
      return jsonResponse({ error }, status);
    }
    const { link } = lookup;
    if (!link.allow_download) {
      return jsonResponse({ error: "Downloads are disabled for this link" }, 403);
    }

    const { data: file, error: fileError } = await supabase
      .from("files")
      .select("id, name, size, mime_type, updated_at, deleted_at")
      .eq("id", link.file_id)
      .maybeSingle();

    if (fileError || !file || file.deleted_at) {
      return jsonResponse({ error: "The shared file is no longer available" }, 404);
    }

    return jsonResponse({
      name: file.name,
      size: file.size,
      mimeType: file.mime_type,
      updatedAt: file.updated_at,
      requiresPassword: Boolean(link.password_hash),
    });
  } catch (error) {
    console.error("Fetch shared file info failed", error);
    return jsonResponse({ error: "Failed to fetch file info" }, 500);
  }
}
