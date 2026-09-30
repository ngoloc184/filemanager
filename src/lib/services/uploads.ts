import { createClient } from "@/lib/supabase/client";
import { findDuplicateFiles } from "@/lib/services/files";
import { assertQuotaForSize, notifyQuotaChanged } from "@/lib/services/quota";
import {
  DEFAULT_MIME_TYPE,
  UPLOADS_BUCKET,
  buildStoragePath,
} from "@/lib/storage";
import { getErrorMessage, type FileRow } from "@/lib/types/database";

/** Files above this size are not hashed client-side (to bound memory use). */
const MAX_CHECKSUM_BYTES = 50 * 1024 * 1024;

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
    if (file.size > MAX_CHECKSUM_BYTES) return null;
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

function mimeTypeOf(file: File): string {
  return file.type || DEFAULT_MIME_TYPE;
}

async function putObject(storagePath: string, file: File): Promise<void> {
  const supabase = createClient();
  const { error } = await supabase.storage
    .from(UPLOADS_BUCKET)
    .upload(storagePath, file, {
      contentType: mimeTypeOf(file),
      cacheControl: "3600",
      upsert: false,
    });
  if (error) throw error;
}

/** Best-effort cleanup of an object whose metadata could not be registered. */
async function removeOrphanObject(storagePath: string): Promise<void> {
  const supabase = createClient();
  await supabase.storage.from(UPLOADS_BUCKET).remove([storagePath]);
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
  const storagePath = buildStoragePath(userId, fileId, versionId, task.file.name);

  onStatus("uploading");
  try {
    await assertQuotaForSize(task.file.size);
  } catch (err) {
    onStatus("failed", getErrorMessage(err));
    throw err;
  }
  const checksum = await computeSha256(task.file);
  if (checksum && onWarning) {
    const duplicates = await findDuplicateFiles(checksum);
    if (duplicates.length > 0) {
      onWarning(`Possible duplicate of "${duplicates[0].name}"`);
    }
  }

  try {
    await putObject(storagePath, task.file);
  } catch (err) {
    onStatus("failed", getErrorMessage(err));
    throw err;
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
        p_mime_type: mimeTypeOf(task.file),
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
    await removeOrphanObject(storagePath);
    onStatus("failed", getErrorMessage(err));
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
  const storagePath = buildStoragePath(userId, fileId, versionId, file.name);
  await assertQuotaForSize(file.size);
  const checksum = await computeSha256(file);

  await putObject(storagePath, file);

  try {
    const { error } = await supabase.rpc("add_file_version", {
      p_file_id: fileId,
      p_storage_path: storagePath,
      p_size: file.size,
      p_mime_type: mimeTypeOf(file),
      p_checksum: checksum,
      p_version_id: versionId,
    });
    if (error) throw error;
    notifyQuotaChanged();
  } catch (err) {
    // keep storage and metadata consistent: remove orphan object
    await removeOrphanObject(storagePath);
    throw err;
  }
}
