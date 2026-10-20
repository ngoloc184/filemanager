import { createClient } from "@/lib/supabase/client";
import type { LinkInput } from "@/lib/saved-links";
import type { SavedLink } from "@/lib/types/database";

// Row-level security limits every query to the signed-in user's own links.

export async function listSavedLinks(): Promise<SavedLink[]> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from("saved_links")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as SavedLink[];
}

export async function createSavedLink(input: LinkInput): Promise<SavedLink> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from("saved_links")
    .insert({ title: input.title, url: input.url })
    .select()
    .single();
  if (error) throw error;
  return data as SavedLink;
}

export async function updateSavedLink(
  id: string,
  input: LinkInput
): Promise<SavedLink> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from("saved_links")
    .update({ title: input.title, url: input.url })
    .eq("id", id)
    .select()
    .single();
  if (error) throw error;
  return data as SavedLink;
}

export async function deleteSavedLink(id: string): Promise<void> {
  const supabase = createClient();
  const { error } = await supabase.from("saved_links").delete().eq("id", id);
  if (error) throw error;
}
