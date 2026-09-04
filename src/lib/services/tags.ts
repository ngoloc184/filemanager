import { createClient } from "@/lib/supabase/client";

export type FileTag = { tag_id: string; name: string };
export type MyTag = { tag_id: string; name: string; file_count: number };

export async function getFileTags(fileId: string): Promise<FileTag[]> {
  const supabase = createClient();
  const { data, error } = await supabase.rpc("get_file_tags", {
    p_file_id: fileId,
  });
  if (error) throw error;
  return (data ?? []) as FileTag[];
}

export async function setFileTags(
  fileId: string,
  tags: string[]
): Promise<FileTag[]> {
  const supabase = createClient();
  const { data, error } = await supabase.rpc("set_file_tags", {
    p_file_id: fileId,
    p_tags: tags,
  });
  if (error) throw error;
  return (data ?? []) as FileTag[];
}

export async function listMyTags(): Promise<MyTag[]> {
  const supabase = createClient();
  const { data, error } = await supabase.rpc("list_my_tags");
  if (error) throw error;
  return (data ?? []) as MyTag[];
}
