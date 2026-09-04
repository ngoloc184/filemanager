import { createClient } from "@/lib/supabase/client";

export type ActivityEvent = {
  id: string;
  actor_id: string;
  actor_email: string | null;
  owner_id: string | null;
  action: string;
  resource_type: "file" | "folder" | "share" | "link";
  resource_id: string | null;
  resource_name: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
};

export async function listActivity(limit = 50): Promise<ActivityEvent[]> {
  const supabase = createClient();
  const { data, error } = await supabase.rpc("list_activity", {
    p_limit: limit,
  });
  if (error) throw error;
  return (data ?? []) as ActivityEvent[];
}
