import { createClient } from "@/lib/supabase/client";
import { notifyQuotaChanged } from "@/lib/services/quota";
import {
  STORAGE_REMOVE_BATCH_SIZE,
  UPLOADS_BUCKET,
  buildStoragePath,
} from "@/lib/storage";
import type { FileRow, FileVersion } from "@/lib/types/database";

export { UPLOADS_BUCKET, sanitizeStorageName } from "@/lib/storage";

const SIGNED_URL_TTL_DOWNLOAD = 60;

type StoragePathRow = { storage_path: string };

export type DownloadableFile = Pick<FileRow, "id" | "name" | "current_version_id">;

export type PreviewableFile = DownloadableFile &
  Pick<FileRow, "mime_type" | "size">;

export async function listFiles(folderId: string | null): Promise<FileRow[]> {
  const supabase = createClient();
  const query = supabase
    .from("files")
    .select("*")
    .is("deleted_at", null)
    .order("name", { ascending: true });
  const scoped = folderId
    ? query.eq("folder_id", folderId)
    : query.is("folder_id", null);
  const { data, error } = await scoped;
  if (error) throw error;
  return (data ?? []) as FileRow[];
}

export async function listRecentFiles(limit = 20): Promise<FileRow[]> {
  const supabase = createClient();
  const { data, error } = await supabase.rpc("list_recent_files", {
    p_limit: limit,
  });
  if (error) throw error;
  return (data ?? []) as FileRow[];
}

export type DuplicateFile = {
  id: string;
  name: string;
  size: number;
  updated_at: string;
};

export async function findDuplicateFiles(
  checksum: string
): Promise<DuplicateFile[]> {
  const supabase = createClient();
  const { data, error } = await supabase.rpc("find_duplicate_files", {
    p_checksum: checksum,
  });
  if (error) return [];
  return (data ?? []) as DuplicateFile[];
}

export async function getFile(id: string): Promise<FileRow> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from("files")
    .select("*")
    .eq("id", id)
    .single();
  if (error) throw error;
  return data as FileRow;
}

export async function getCurrentVersion(
  file: DownloadableFile
): Promise<FileVersion | null> {
  if (!file.current_version_id) return null;
  const supabase = createClient();
  const { data, error } = await supabase
    .from("file_versions")
    .select("*")
    .eq("id", file.current_version_id)
    .maybeSingle();
  if (error) throw error;
  return (data as FileVersion | null) ?? null;
}

export async function listVersions(fileId: string): Promise<FileVersion[]> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from("file_versions")
    .select("*")
    .eq("file_id", fileId)
    .order("version_no", { ascending: false });
  if (error) throw error;
  return (data ?? []) as FileVersion[];
}

export async function getSignedUrl(
  file: DownloadableFile,
  ttl: number = SIGNED_URL_TTL_DOWNLOAD
): Promise<string> {
  const version = await getCurrentVersion(file);
  if (!version) throw new Error("File has no downloadable version");
  const supabase = createClient();
  const { data, error } = await supabase.storage
    .from(UPLOADS_BUCKET)
    .createSignedUrl(version.storage_path, ttl);
  if (error) throw error;
  return data.signedUrl;
}

function triggerBrowserDownload(url: string, fileName: string): void {
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

export async function downloadFile(file: DownloadableFile): Promise<void> {
  const url = await getSignedUrl(file, SIGNED_URL_TTL_DOWNLOAD);
  triggerBrowserDownload(url, file.name);
}

export async function renameFile(id: string, name: string): Promise<void> {
  const supabase = createClient();
  const { error } = await supabase.rpc("rename_file", {
    p_id: id,
    p_name: name,
  });
  if (error) throw error;
}

export async function moveFile(
  id: string,
  folderId: string | null
): Promise<void> {
  const supabase = createClient();
  const { error } = await supabase.rpc("move_file", {
    p_id: id,
    p_folder_id: folderId,
  });
  if (error) throw error;
}

export async function toggleFileVisibility(file: FileRow): Promise<FileRow> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from("files")
    .update({ is_public: !file.is_public })
    .eq("id", file.id)
    .select()
    .single();
  if (error) throw error;
  return data as FileRow;
}

export async function softDeleteFile(id: string): Promise<void> {
  const supabase = createClient();
  const { error } = await supabase.rpc("soft_delete_file", { p_id: id });
  if (error) throw error;
}

export async function restoreFile(id: string): Promise<void> {
  const supabase = createClient();
  const { error } = await supabase.rpc("restore_file", { p_id: id });
  if (error) throw error;
}

/** Removes storage objects in batches the Storage API accepts. */
async function removeStorageObjects(paths: string[]): Promise<void> {
  const supabase = createClient();
  for (let i = 0; i < paths.length; i += STORAGE_REMOVE_BATCH_SIZE) {
    const chunk = paths.slice(i, i + STORAGE_REMOVE_BATCH_SIZE);
    const { error } = await supabase.storage.from(UPLOADS_BUCKET).remove(chunk);
    if (error) throw error;
  }
}

/**
 * Deletes the storage objects returned by `pathsRpc`, then the database rows
 * via `deleteRpc`. Storage goes first so a failure never leaves orphan objects
 * without metadata pointing at them.
 */
async function hardDelete(
  pathsRpc: string,
  pathsArgs: Record<string, unknown> | undefined,
  deleteRpc: string,
  deleteArgs: Record<string, unknown> | undefined
): Promise<unknown> {
  const supabase = createClient();
  const { data: paths, error: pathsError } = await supabase.rpc(
    pathsRpc,
    pathsArgs
  );
  if (pathsError) throw pathsError;

  await removeStorageObjects(
    ((paths ?? []) as StoragePathRow[]).map((row) => row.storage_path)
  );

  const { data, error } = await supabase.rpc(deleteRpc, deleteArgs);
  if (error) throw error;
  notifyQuotaChanged();
  return data;
}

export async function hardDeleteFile(id: string): Promise<void> {
  await hardDelete(
    "get_file_version_paths",
    { p_file_id: id },
    "hard_delete_file",
    { p_id: id }
  );
}

export async function hardDeleteFolderContents(
  folderId: string
): Promise<void> {
  await hardDelete(
    "get_folder_storage_paths",
    { p_folder_id: folderId },
    "hard_delete_folder",
    { p_id: folderId }
  );
}

/** Permanently deletes everything in the caller's trash. */
export async function hardDeleteTrash(): Promise<{
  folders_deleted: number;
  files_deleted: number;
}> {
  const result = await hardDelete(
    "get_trash_storage_paths",
    undefined,
    "empty_trash",
    undefined
  );
  return result as { folders_deleted: number; files_deleted: number };
}

export async function copyFile(
  source: FileRow,
  destFolderId: string | null,
  newName: string,
  currentUserId: string
): Promise<FileRow> {
  const supabase = createClient();
  const version = await getCurrentVersion(source);
  if (!version) throw new Error("File has no version to copy");

  const newFileId = crypto.randomUUID();
  const newVersionId = crypto.randomUUID();
  const destPath = buildStoragePath(
    currentUserId,
    newFileId,
    newVersionId,
    source.name
  );

  const { error: copyError } = await supabase.storage
    .from(UPLOADS_BUCKET)
    .copy(version.storage_path, destPath);
  if (copyError) throw copyError;

  try {
    const { data, error } = await supabase
      .rpc("copy_file", {
        p_id: source.id,
        p_folder_id: destFolderId,
        p_name: newName,
        p_storage_path: destPath,
        p_new_id: newFileId,
      })
      .select()
      .single();
    if (error) throw error;
    notifyQuotaChanged();
    return data as FileRow;
  } catch (err) {
    await supabase.storage.from(UPLOADS_BUCKET).remove([destPath]);
    throw err;
  }
}

export async function downloadVersion(
  version: FileVersion,
  fileName: string
): Promise<void> {
  const supabase = createClient();
  const { data, error } = await supabase.storage
    .from(UPLOADS_BUCKET)
    .createSignedUrl(version.storage_path, SIGNED_URL_TTL_DOWNLOAD);
  if (error) throw error;
  triggerBrowserDownload(data.signedUrl, fileName);
}

export async function restoreVersion(
  fileId: string,
  versionId: string
): Promise<FileVersion> {
  const supabase = createClient();
  const { data, error } = await supabase
    .rpc("restore_file_version", {
      p_file_id: fileId,
      p_version_id: versionId,
    })
    .select()
    .single();
  if (error) throw error;
  return data as FileVersion;
}
