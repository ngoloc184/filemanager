import { createClient } from "@/lib/supabase/client";
import { notifyQuotaChanged } from "@/lib/services/quota";
import {
  STORAGE_REMOVE_BATCH_SIZE,
  UPLOADS_BUCKET,
  buildStoragePath,
} from "@/lib/storage";
import { decodeTextFile } from "@/lib/text-files";
import type { FileRow, FileVersion, Folder } from "@/lib/types/database";

export { UPLOADS_BUCKET, sanitizeStorageName } from "@/lib/storage";

const SIGNED_URL_TTL_DOWNLOAD = 60;

type StoragePathRow = { storage_path: string };

export type DownloadableFile = Pick<FileRow, "id" | "name" | "current_version_id">;

export type PreviewableFile = DownloadableFile &
  Pick<FileRow, "mime_type" | "size">;

/** Items per list that one folder listing returns (list_folder_items p_limit). */
export const FOLDER_LISTING_LIMIT = 2000;

export type FolderItems = {
  folders: Folder[];
  files: FileRow[];
  /** true when the folder holds more than FOLDER_LISTING_LIMIT folders or files */
  truncated: boolean;
};

/**
 * Lists one folder (or the caller's My Files root when `folderId` is null)
 * with the caller's role on every item. The root only ever holds the
 * caller's own items; shared and public items are reached through Shared,
 * Search or links.
 */
export async function listFolderItems(folderId: string | null): Promise<FolderItems> {
  const supabase = createClient();
  const { data, error } = await supabase.rpc("list_folder_items", {
    p_folder_id: folderId,
    p_limit: FOLDER_LISTING_LIMIT,
  });
  if (error?.code === "PGRST202") return listFolderItemsFallback(folderId);
  if (error) throw error;
  const result = (data ?? {}) as Partial<FolderItems>;
  return {
    folders: result.folders ?? [],
    files: result.files ?? [],
    truncated: result.truncated === true,
  };
}

/**
 * Table queries for databases without list_folder_items (migration 033 not
 * applied yet). Their real role is unknown, so items are marked viewer and
 * the UI only offers to manage the caller's own items.
 */
async function listFolderItemsFallback(folderId: string | null): Promise<FolderItems> {
  const supabase = createClient();
  let foldersQuery = supabase.from("folders").select("*").is("deleted_at", null);
  let filesQuery = supabase.from("files").select("*").is("deleted_at", null);
  if (folderId) {
    foldersQuery = foldersQuery.eq("parent_id", folderId);
    filesQuery = filesQuery.eq("folder_id", folderId);
  } else {
    // root: only the caller's own items, like the RPC
    const { data, error } = await supabase.auth.getUser();
    if (error) throw error;
    const ownerId = data.user?.id;
    if (!ownerId) throw new Error("Not signed in");
    foldersQuery = foldersQuery.is("parent_id", null).eq("owner_id", ownerId);
    filesQuery = filesQuery.is("folder_id", null).eq("owner_id", ownerId);
  }

  const [foldersResult, filesResult] = await Promise.all([
    foldersQuery.order("name", { ascending: true }).limit(FOLDER_LISTING_LIMIT + 1),
    filesQuery.order("name", { ascending: true }).limit(FOLDER_LISTING_LIMIT + 1),
  ]);
  if (foldersResult.error) throw foldersResult.error;
  if (filesResult.error) throw filesResult.error;
  // RLS only returns rows the caller can view; roleOf() upgrades their own to owner
  const folders = ((foldersResult.data ?? []) as Folder[]).map(
    (folder): Folder => ({ ...folder, my_role: "viewer" })
  );
  const files = ((filesResult.data ?? []) as FileRow[]).map(
    (file): FileRow => ({ ...file, my_role: "viewer" })
  );
  return {
    folders: folders.slice(0, FOLDER_LISTING_LIMIT),
    files: files.slice(0, FOLDER_LISTING_LIMIT),
    truncated:
      folders.length > FOLDER_LISTING_LIMIT || files.length > FOLDER_LISTING_LIMIT,
  };
}

/** Files of one folder (or the caller's own root files); see listFolderItems. */
export async function listFiles(folderId: string | null): Promise<FileRow[]> {
  return (await listFolderItems(folderId)).files;
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

/** Reads the current version of a (small) UTF-8 text file for editing. */
export async function readTextFile(
  file: DownloadableFile
): Promise<{ text: string; bom: boolean }> {
  const url = await getSignedUrl(file, SIGNED_URL_TTL_DOWNLOAD);
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`Could not read the file (HTTP ${response.status})`);
  const decoded = decodeTextFile(new Uint8Array(await response.arrayBuffer()));
  if (!decoded) {
    throw new Error(
      "This file is not UTF-8 text, so it cannot be edited here without damaging it. Download it to edit it instead."
    );
  }
  return decoded;
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

/** Text the documents freeze trigger raises for a registered/issued document's file. */
const FROZEN_FILE_PATTERN = /locked because the document was registered or issued/i;

/** A readable error when the database refused because a file is frozen. */
function frozenFileError(err: unknown, message: string): unknown {
  const text =
    typeof err === "object" && err !== null && "message" in err
      ? String((err as { message: unknown }).message)
      : "";
  return FROZEN_FILE_PATTERN.test(text) ? new Error(message) : err;
}

export async function hardDeleteFile(id: string): Promise<void> {
  try {
    await hardDelete(
      "get_file_version_paths",
      { p_file_id: id },
      "hard_delete_file",
      { p_id: id }
    );
  } catch (err) {
    throw frozenFileError(
      err,
      "This file belongs to a registered or issued document (văn bản), so it cannot be deleted permanently."
    );
  }
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
  try {
    const result = await hardDelete(
      "get_trash_storage_paths",
      undefined,
      "empty_trash",
      undefined
    );
    return result as { folders_deleted: number; files_deleted: number };
  } catch (err) {
    throw frozenFileError(
      err,
      "The trash holds a file of a registered or issued document (văn bản), which cannot be deleted permanently. Restore that file, then empty the trash again."
    );
  }
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

/**
 * Permanently deletes one old (not current) version. Needs admin on the file.
 * The database row goes first; the stored object is then removed. If that
 * removal fails (or the object belongs to another uploader), the daily
 * cleanup job removes it later.
 */
export async function deleteVersion(versionId: string): Promise<void> {
  const supabase = createClient();
  const { data, error } = await supabase.rpc("delete_file_version", {
    p_version_id: versionId,
  });
  if (error) throw error;
  const path = typeof data === "string" && data ? data : null;
  if (path) {
    const { error: removeError } = await supabase.storage
      .from(UPLOADS_BUCKET)
      .remove([path]);
    if (removeError) {
      console.warn("Version deleted; its stored object is left for the cleanup job", removeError.message);
    }
  }
  notifyQuotaChanged();
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
