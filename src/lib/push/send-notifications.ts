import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { safeLink } from "@/lib/notifications";
import { sendPush, vapidDetails, type PushTarget } from "@/lib/push/web-push";

export type PushableNotification = {
  id: string;
  user_id: string;
  title: string;
  body: string | null;
  link: string | null;
  kind: string;
};

/** pushes in flight at once */
const CONCURRENCY = 20;

/** Runs `work` over `items` with at most `limit` running at a time. */
async function pool<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Sends notification rows as Web Push to their recipients' devices, each row
 * once: it is claimed in notification_push_log first, so concurrent callers
 * (the actor's tabs, the reminder cron) never push it twice. Recipients who
 * turned activity push off are skipped (no preference row means on). Devices
 * the push service reports as gone are removed. `admin` must be a
 * service-role client.
 */
export async function pushNotificationRows(
  admin: SupabaseClient,
  rows: PushableNotification[],
  origin: string
): Promise<{ sent: number; gone: number }> {
  const vapid = vapidDetails(origin);
  if (!vapid || rows.length === 0) return { sent: 0, gone: 0 };

  // claim: only rows inserted by this call come back (on conflict do nothing)
  const { data: claimedRows, error: claimError } = await admin
    .from("notification_push_log")
    .upsert(
      rows.map((row) => ({ notification_id: row.id })),
      { onConflict: "notification_id", ignoreDuplicates: true }
    )
    .select("notification_id");
  if (claimError) return { sent: 0, gone: 0 };
  const claimed = new Set((claimedRows ?? []).map((r) => r.notification_id as string));
  const mine = rows.filter((row) => claimed.has(row.id));
  if (mine.length === 0) return { sent: 0, gone: 0 };

  const users = [...new Set(mine.map((row) => row.user_id))];
  const [{ data: optedOut }, { data: subscriptions }] = await Promise.all([
    admin.from("user_preferences").select("user_id").in("user_id", users).eq("activity_push", false),
    admin.from("push_subscriptions").select("id, user_id, endpoint, p256dh, auth").in("user_id", users),
  ]);
  const off = new Set((optedOut ?? []).map((p) => p.user_id as string));
  const devices = new Map<string, PushTarget[]>();
  for (const s of (subscriptions ?? []) as (PushTarget & { user_id: string })[]) {
    if (off.has(s.user_id)) continue;
    devices.set(s.user_id, [...(devices.get(s.user_id) ?? []), s]);
  }

  const jobs = mine.flatMap((row) =>
    (devices.get(row.user_id) ?? []).map((target) => ({
      target,
      payload: {
        type: "notification",
        title: row.title,
        body: row.body ?? "",
        url: safeLink(row.link ?? "/dashboard"),
        tag: `n:${row.id}`,
      },
    }))
  );
  if (jobs.length === 0) return { sent: 0, gone: 0 };

  const results = await pool(jobs, CONCURRENCY, async (job) => ({
    id: job.target.id,
    result: await sendPush(job.target, job.payload, vapid),
  }));

  const gone = [...new Set(results.filter((r) => r.result === "gone").map((r) => r.id))];
  const sent = results.filter((r) => r.result === "sent");
  const sentDevices = [...new Set(sent.map((r) => r.id))].filter((id) => !gone.includes(id));
  await Promise.all([
    gone.length ? admin.from("push_subscriptions").delete().in("id", gone) : null,
    sentDevices.length
      ? admin.from("push_subscriptions").update({ last_used_at: new Date().toISOString() }).in("id", sentDevices)
      : null,
  ]);
  return { sent: sent.length, gone: gone.length };
}
