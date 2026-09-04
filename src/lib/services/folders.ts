import { createClient } from "@/lib/supabase/client";
import type { Folder, FolderAncestor } from "@/lib/types/database";

export async function listFolders(parentId: string | null): Promise<Folder[]> {
  const supabase = createClient();
  const query = supabase
    .from("folders")
    .select("*")
    .is("deleted_at", null)
    .order("name", { ascending: true });
  const scoped = parentId
    ? query.eq("parent_id", parentId)
    : query.is("parent_id", null);
  const { data, error } = await scoped;
  if (error) throw error;
  return (data ?? []) as Folder[];
}

export async function createFolder(
  parentId: string | null,
  name: string,
  comment: string | null = null
): Promise<Folder> {
  const supabase = createClient();
  const { data, error } = await supabase
    .rpc("create_folder", {
      p_parent_id: parentId,
      p_name: name,
      p_comment: comment,
    })
    .select()
    .single();
  if (error) throw error;
  return data as Folder;
}

export async function renameFolder(id: string, name: string): Promise<void> {
  const supabase = createClient();
  const { error } = await supabase.rpc("rename_folder", {
    p_id: id,
    p_name: name,
  });
  if (error) throw error;
}

export async function updateFolderComment(
  id: string,
  comment: string | null
): Promise<void> {
  const supabase = createClient();
  const { error } = await supabase.rpc("update_folder_comment", {
    p_id: id,
    p_comment: comment,
  });
  if (error) throw error;
}

export async function moveFolder(
  id: string,
  newParentId: string | null
): Promise<void> {
  const supabase = createClient();
  const { error } = await supabase.rpc("move_folder", {
    p_id: id,
    p_new_parent_id: newParentId,
  });
  if (error) throw error;
}

export async function softDeleteFolder(id: string): Promise<void> {
  const supabase = createClient();
  const { error } = await supabase.rpc("soft_delete_folder", { p_id: id });
  if (error) throw error;
}

export async function restoreFolder(id: string): Promise<void> {
  const supabase = createClient();
  const { error } = await supabase.rpc("restore_folder", { p_id: id });
  if (error) throw error;
}

export async function hardDeleteFolder(id: string): Promise<void> {
  const supabase = createClient();
  const { error } = await supabase.rpc("hard_delete_folder", { p_id: id });
  if (error) throw error;
}

export async function getFolderPath(id: string): Promise<FolderAncestor[]> {
  const supabase = createClient();
  const { data, error } = await supabase.rpc("get_folder_ancestors", {
    p_id: id,
  });
  if (error) throw error;
  return (data ?? []) as FolderAncestor[];
}
