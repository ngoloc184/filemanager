import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { UPLOADS_BUCKET } from "@/lib/storage";
import { isValidSuperAppName } from "@/lib/superapp";

export const dynamic = "force-dynamic";

const SIGNED_URL_TTL_SECONDS = 60;
const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Public download for files published through the SuperApp API.
 * Redirects to a short-lived signed URL that forces
 * `Content-Disposition: attachment`, so the browser downloads immediately.
 */
export async function GET(
  _request: Request,
  { params }: RouteContext<"/superapp/[name]">
) {
  const { name } = await params;
  if (!isValidSuperAppName(name)) {
    return new NextResponse("File not found.", { status: 404, headers: NO_STORE });
  }

  try {
    const supabase = createAdminClient();
    const { data: file, error } = await supabase
      .from("superapp_files")
      .select("name, storage_path")
      .eq("name", name)
      .maybeSingle();
    if (error || !file) {
      return new NextResponse("File not found.", { status: 404, headers: NO_STORE });
    }

    const { data: signed, error: signError } = await supabase.storage
      .from(UPLOADS_BUCKET)
      .createSignedUrl(file.storage_path, SIGNED_URL_TTL_SECONDS, {
        download: file.name,
      });
    if (signError || !signed) {
      return new NextResponse("Unable to prepare the download.", {
        status: 500,
        headers: NO_STORE,
      });
    }

    const response = NextResponse.redirect(signed.signedUrl);
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    console.error("SuperApp download failed", error);
    return new NextResponse("File downloads are unavailable.", {
      status: 503,
      headers: NO_STORE,
    });
  }
}
