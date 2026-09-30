import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { DEFAULT_MIME_TYPE, UPLOADS_BUCKET } from "@/lib/storage";
import {
  isAuthorizedSuperAppRequest,
  isValidSuperAppName,
  superAppStoragePath,
} from "@/lib/superapp";

export const dynamic = "force-dynamic";

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

/**
 * Publishes a file at /superapp/<name>.
 *
 * Request: multipart/form-data with a `file` field and an optional `name`
 * field (defaults to the uploaded file name). Uploading an existing name
 * replaces that file.
 * Auth: `Authorization: Bearer <SUPERAPP_API_KEY>` or `X-API-Key: <key>`.
 */
export async function POST(request: Request) {
  if (!isAuthorizedSuperAppRequest(request)) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return jsonResponse(
      { error: "Expected multipart/form-data with a 'file' field" },
      400
    );
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return jsonResponse({ error: "Missing 'file' field" }, 400);
  }

  const nameField = form.get("name");
  const name = (typeof nameField === "string" && nameField.trim()) || file.name;
  if (!isValidSuperAppName(name)) {
    return jsonResponse(
      {
        error:
          "Invalid name: use 1-200 letters, digits, '.', '_' or '-', starting with a letter or digit",
      },
      400
    );
  }

  try {
    const supabase = createAdminClient();
    const storagePath = superAppStoragePath(name);
    const mimeType = file.type || DEFAULT_MIME_TYPE;

    const { error: uploadError } = await supabase.storage
      .from(UPLOADS_BUCKET)
      .upload(storagePath, file, { contentType: mimeType, upsert: true });
    if (uploadError) {
      console.error("SuperApp upload failed", uploadError);
      return jsonResponse({ error: "Failed to store file" }, 500);
    }

    const { error: dbError } = await supabase.from("superapp_files").upsert({
      name,
      storage_path: storagePath,
      mime_type: mimeType,
      size: file.size,
      updated_at: new Date().toISOString(),
    });
    if (dbError) {
      console.error("SuperApp metadata save failed", dbError);
      return jsonResponse({ error: "Failed to register file" }, 500);
    }

    const url = new URL(
      `/superapp/${encodeURIComponent(name)}`,
      request.url
    ).toString();
    return jsonResponse(
      { name, size: file.size, mimeType, url },
      201
    );
  } catch (error) {
    console.error("SuperApp publish failed", error);
    return jsonResponse({ error: "SuperApp publishing is unavailable" }, 503);
  }
}
