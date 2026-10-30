import type { RealtimePostgresChangesPayload } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";
import { getErrorMessage } from "@/lib/types/database";
import type { NotificationRow } from "@/lib/notifications";

export type { NotificationRow } from "@/lib/notifications";

/** Readable errors, including a missing migration. */
function notificationsError(error: unknown): Error {
  const code = (error as { code?: string } | null)?.code;
  const message = getErrorMessage(error);
  if (code === "PGRST202" || code === "PGRST205" || /could not find the function/i.test(message)) {
    return new Error("Notifications are not set up yet. Run migration 202608280035_notifications.sql.");
  }
  return new Error(message);
}

/** The caller's notifications, newest first; pass the oldest `created_at` seen to page. */
export async function listNotifications(options: { before?: string | null; limit?: number } = {}): Promise<NotificationRow[]> {
  const { data, error } = await createClient().rpc("list_notifications", {
    p_before: options.before ?? null,
    p_limit: options.limit ?? 30,
  });
  if (error) throw notificationsError(error);
  return (data ?? []) as NotificationRow[];
}

export async function unreadCount(): Promise<number> {
  const { data, error } = await createClient().rpc("unread_notification_count");
  if (error) throw notificationsError(error);
  return typeof data === "number" ? data : 0;
}

/** Marks the given notifications read (all of them when no ids); returns how many changed. */
export async function markRead(ids?: string[]): Promise<number> {
  const { data, error } = await createClient().rpc("mark_notifications_read", {
    p_ids: ids && ids.length > 0 ? ids : null,
  });
  if (error) throw notificationsError(error);
  return typeof data === "number" ? data : 0;
}

/**
 * Asks the server to push the notifications the caller's last action created
 * to the recipients' devices. Fire-and-forget: a failed push never fails the
 * action, and `keepalive` lets it finish when the page navigates away.
 */
export function flushNotificationPush(): void {
  if (typeof fetch !== "function" || typeof window === "undefined") return;
  try {
    void fetch("/api/push/notifications", { method: "POST", keepalive: true, credentials: "same-origin" }).catch(() => {});
  } catch {
    // ignored: push is best effort
  }
}

const suffix = () => Math.random().toString(36).slice(2);

/** Calls `onInsert` for each new notification of `userId`; returns the unsubscribe. */
export function subscribeNotifications(userId: string, onInsert: (row: NotificationRow) => void): () => void {
  const supabase = createClient();
  const channel = supabase
    .channel(`notifications-${userId}-${suffix()}`)
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "notifications", filter: `user_id=eq.${userId}` },
      (payload: RealtimePostgresChangesPayload<Record<string, unknown>>) => {
        const row = payload.new as Partial<NotificationRow> & { id?: string };
        if (!row?.id || typeof row.title !== "string") return;
        // Realtime sends the table row: the actor's name comes from list_notifications
        onInsert({
          id: row.id,
          kind: row.kind ?? "",
          entity_type: row.entity_type ?? null,
          entity_id: row.entity_id ?? null,
          title: row.title,
          body: row.body ?? null,
          link: row.link ?? null,
          created_at: row.created_at ?? new Date().toISOString(),
          read_at: row.read_at ?? null,
          actor_id: row.actor_id ?? null,
          actor_name: null,
        });
      }
    )
    .subscribe();
  return () => {
    void supabase.removeChannel(channel);
  };
}

/** Device push for activity (shares, comments, documents); on when never set. */
export async function getActivityPush(): Promise<boolean> {
  const { data, error } = await createClient().from("user_preferences").select("activity_push").maybeSingle();
  if (error) throw notificationsError(error);
  return data?.activity_push !== false;
}

export async function setActivityPush(on: boolean): Promise<void> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Sign in to change notification settings");
  const { error } = await supabase
    .from("user_preferences")
    .upsert({ user_id: user.id, activity_push: on }, { onConflict: "user_id" });
  if (error) throw notificationsError(error);
}
