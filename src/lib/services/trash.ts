import { createClient } from "@/lib/supabase/client";
import { restoreFolder } from "@/lib/services/folders";
import {
  hardDeleteFile,
  hardDeleteFolderContents,
  hardDeleteTrash,
  restoreFile,
} from "@/lib/services/files";

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

export async function permanentDeleteItem(item: TrashItem): Promise<void> {
  if (item.item_type === "folder") {
    await hardDeleteFolderContents(item.id);
  } else {
    await hardDeleteFile(item.id);
  }
}

export async function emptyTrash(): Promise<{
  folders_deleted: number;
  files_deleted: number;
}> {
  return hardDeleteTrash();
}
