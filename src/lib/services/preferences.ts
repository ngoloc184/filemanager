import { createClient } from "@/lib/supabase/client";
import { getErrorMessage } from "@/lib/types/database";

/** Readable errors, including a missing migration. */
function preferencesError(error: unknown): Error {
  const code = (error as { code?: string } | null)?.code;
  const message = getErrorMessage(error);
  if (code === "PGRST205" || code === "42P01" || /user_preferences/i.test(message)) {
    return new Error("Notification settings are not set up yet. Run migration 202608280026_user_preferences.sql.");
  }
  return new Error(message);
}

/** The account switch for chat notifications (off when never set). */
export async function getChatNotifications(userId: string): Promise<boolean> {
  const { data, error } = await createClient()
    .from("user_preferences")
    .select("chat_notifications")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw preferencesError(error);
  return Boolean(data?.chat_notifications);
}

export async function setChatNotifications(userId: string, enabled: boolean): Promise<void> {
  const { error } = await createClient()
    .from("user_preferences")
    .upsert({ user_id: userId, chat_notifications: enabled }, { onConflict: "user_id" });
  if (error) throw preferencesError(error);
}
