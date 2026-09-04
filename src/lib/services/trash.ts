import { createClient } from "@/lib/supabase/client";
import { UPLOADS_BUCKET } from "@/lib/services/files";
import { restoreFolder } from "@/lib/services/folders";
import { restoreFile } from "@/lib/services/files";

export type TrashItem = {
  item_type: "folder" | "file";
  id: string;
  name: string;
  size: number | null;
  deleted_at: string;
  location: string | null;
};

export async function listTrash(): Promise<TrashItem[]> {
  const supabase = createClient();
  const { data, error } = await supabase.rpc("list_trash");
  if (error) throw error;
  return (data ?? []) as TrashItem[];
}

export async function restoreTrashItem(item: TrashItem): Promise<void> {
  if (item.item_type === "folder") {
    await restoreFolder(item.id);
  } else {
    await restoreFile(item.id);
  }
}

async function removeStoragePaths(paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  const supabase = createClient();
  for (let i = 0; i < paths.length; i += 100) {
    const chunk = paths.slice(i, i + 100);
    const { error } = await supabase.storage.from(UPLOADS_BUCKET).remove(chunk);
    if (error) throw error;
  }
}

export async function permanentDeleteItem(item: TrashItem): Promise<void> {
  const supabase = createClient();
  if (item.item_type === "folder") {
    const { data: paths, error: pathsError } = await supabase.rpc(
      "get_folder_storage_paths",
      { p_folder_id: item.id }
    );
    if (pathsError) throw pathsError;
    await removeStoragePaths(
      ((paths ?? []) as { storage_path: string }[]).map((row) => row.storage_path)
    );
    const { error } = await supabase.rpc("hard_delete_folder", { p_id: item.id });
    if (error) throw error;
  } else {
    const { data: paths, error: pathsError } = await supabase.rpc(
      "get_file_version_paths",
      { p_file_id: item.id }
    );
    if (pathsError) throw pathsError;
    await removeStoragePaths(
      ((paths ?? []) as { storage_path: string }[]).map((row) => row.storage_path)
    );
    const { error } = await supabase.rpc("hard_delete_file", { p_id: item.id });
    if (error) throw error;
  }
}

export async function emptyTrash(): Promise<{
  folders_deleted: number;
  files_deleted: number;
}> {
  const supabase = createClient();
  const { data: paths, error: pathsError } = await supabase.rpc(
    "get_trash_storage_paths"
  );
  if (pathsError) throw pathsError;
  await removeStoragePaths(
    ((paths ?? []) as { storage_path: string }[]).map((row) => row.storage_path)
  );

  const { data, error } = await supabase.rpc("empty_trash");
  if (error) throw error;
  return data as { folders_deleted: number; files_deleted: number };
}
