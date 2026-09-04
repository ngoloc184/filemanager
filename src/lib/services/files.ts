import { createClient } from "@/lib/supabase/client";
import { notifyQuotaChanged } from "@/lib/services/quota";
import type { FileRow, FileVersion } from "@/lib/types/database";

export const UPLOADS_BUCKET = "uploads";
const SIGNED_URL_TTL_DOWNLOAD = 60;

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

export async function downloadFile(file: DownloadableFile): Promise<void> {
  const url = await getSignedUrl(file, SIGNED_URL_TTL_DOWNLOAD);
  const link = document.createElement("a");
  link.href = url;
  link.download = file.name;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
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

export async function hardDeleteFile(id: string): Promise<void> {
  const supabase = createClient();
  const { data: paths, error: pathsError } = await supabase.rpc(
    "get_file_version_paths",
    { p_file_id: id }
  );
  if (pathsError) throw pathsError;

  const storagePaths = ((paths ?? []) as { storage_path: string }[]).map(
    (row) => row.storage_path
  );
  if (storagePaths.length > 0) {
    const { error: storageError } = await supabase.storage
      .from(UPLOADS_BUCKET)
      .remove(storagePaths);
    if (storageError) throw storageError;
  }

  const { error } = await supabase.rpc("hard_delete_file", { p_id: id });
  if (error) throw error;
  notifyQuotaChanged();
}

export async function hardDeleteFolderContents(
  folderId: string
): Promise<void> {
  const supabase = createClient();
  const { data: paths, error: pathsError } = await supabase.rpc(
    "get_folder_storage_paths",
    { p_folder_id: folderId }
  );
  if (pathsError) throw pathsError;

  const storagePaths = ((paths ?? []) as { storage_path: string }[]).map(
    (row) => row.storage_path
  );
  // storage.remove accepts at most 100 paths per call
  for (let i = 0; i < storagePaths.length; i += 100) {
    const chunk = storagePaths.slice(i, i + 100);
    const { error: storageError } = await supabase.storage
      .from(UPLOADS_BUCKET)
      .remove(chunk);
    if (storageError) throw storageError;
  }

  const { error } = await supabase.rpc("hard_delete_folder", {
    p_id: folderId,
  });
  if (error) throw error;
  notifyQuotaChanged();
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
  const destPath = `${currentUserId}/${newFileId}/${newVersionId}/${sanitizeStorageName(source.name)}`;

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

export function sanitizeStorageName(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 180);
  return cleaned || "file";
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
  const link = document.createElement("a");
  link.href = data.signedUrl;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
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
