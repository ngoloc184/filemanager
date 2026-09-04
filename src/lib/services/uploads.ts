import { createClient } from "@/lib/supabase/client";
import {
  UPLOADS_BUCKET,
  findDuplicateFiles,
  sanitizeStorageName,
} from "@/lib/services/files";
import { assertQuotaForSize, notifyQuotaChanged } from "@/lib/services/quota";
import type { FileRow } from "@/lib/types/database";

export type UploadStatus =
  | "pending"
  | "uploading"
  | "registering"
  | "done"
  | "failed";

export type UploadTask = {
  localId: string;
  file: File;
  folderId: string | null;
  status: UploadStatus;
  error?: string;
  fileId?: string;
};

export function createUploadTasks(
  files: File[],
  folderId: string | null
): UploadTask[] {
  return files.map((file) => ({
    localId: crypto.randomUUID(),
    file,
    folderId,
    status: "pending",
  }));
}

export async function computeSha256(file: File): Promise<string | null> {
  try {
    if (file.size > 50 * 1024 * 1024) return null;
    const buffer = await file.arrayBuffer();
    const digest = await crypto.subtle.digest("SHA-256", buffer);
    return Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    return null;
  }
}

function fileExtension(name: string): string {
  const base = name.split("/").pop() ?? name;
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return "";
  return base.slice(dot + 1).toLowerCase();
}

export async function uploadOne(
  userId: string,
  task: UploadTask,
  onStatus: (status: UploadStatus, error?: string) => void,
  onWarning?: (message: string) => void
): Promise<FileRow> {
  const supabase = createClient();
  const fileId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  const storagePath = `${userId}/${fileId}/${versionId}/${sanitizeStorageName(task.file.name)}`;

  onStatus("uploading");
  try {
    await assertQuotaForSize(task.file.size);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Storage quota exceeded";
    onStatus("failed", message);
    throw err;
  }
  const checksum = await computeSha256(task.file);
  if (checksum && onWarning) {
    const duplicates = await findDuplicateFiles(checksum);
    if (duplicates.length > 0) {
      onWarning(`Possible duplicate of "${duplicates[0].name}"`);
    }
  }

  const { error: uploadError } = await supabase.storage
    .from(UPLOADS_BUCKET)
    .upload(storagePath, task.file, {
      contentType: task.file.type || "application/octet-stream",
      cacheControl: "3600",
      upsert: false,
    });
  if (uploadError) {
    onStatus("failed", uploadError.message);
    throw uploadError;
  }

  onStatus("registering");
  try {
    const { data, error } = await supabase
      .rpc("register_file", {
        p_id: fileId,
        p_folder_id: task.folderId,
        p_name: task.file.name,
        p_original_name: task.file.name,
        p_extension: fileExtension(task.file.name),
        p_mime_type: task.file.type || "application/octet-stream",
        p_size: task.file.size,
        p_storage_path: storagePath,
        p_checksum: checksum,
        p_version_id: versionId,
      })
      .select()
      .single();
    if (error) throw error;
    onStatus("done");
    notifyQuotaChanged();
    return data as FileRow;
  } catch (err) {
    // keep storage and metadata consistent: remove orphan object
    await supabase.storage.from(UPLOADS_BUCKET).remove([storagePath]);
    const message =
      err instanceof Error ? err.message : "Failed to register file";
    onStatus("failed", message);
    throw err;
  }
}

export async function uploadNewVersion(
  userId: string,
  fileId: string,
  file: File
): Promise<void> {
  const supabase = createClient();
  const versionId = crypto.randomUUID();
  const storagePath = `${userId}/${fileId}/${versionId}/${sanitizeStorageName(file.name)}`;
  await assertQuotaForSize(file.size);
  const checksum = await computeSha256(file);

  const { error: uploadError } = await supabase.storage
    .from(UPLOADS_BUCKET)
    .upload(storagePath, file, {
      contentType: file.type || "application/octet-stream",
      cacheControl: "3600",
      upsert: false,
    });
  if (uploadError) throw uploadError;

  try {
    const { error } = await supabase.rpc("add_file_version", {
      p_file_id: fileId,
      p_storage_path: storagePath,
      p_size: file.size,
      p_mime_type: file.type || "application/octet-stream",
      p_checksum: checksum,
      p_version_id: versionId,
    });
    if (error) throw error;
    notifyQuotaChanged();
  } catch (err) {
    // keep storage and metadata consistent: remove orphan object
    await supabase.storage.from(UPLOADS_BUCKET).remove([storagePath]);
    throw err;
  }
}
