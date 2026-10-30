import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { vapidDetails } from "@/lib/push/web-push";
import { pushNotificationRows, type PushableNotification } from "@/lib/push/send-notifications";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** only notifications this fresh are pushed */
const MAX_AGE_MS = 5 * 60 * 1000;
/** rows per call; a later call picks up the rest */
const BATCH = 200;

const json = (body: Record<string, unknown>, status = 200) =>
  NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

/**
 * POST /api/push/notifications — called by the app right after an action
 * that may notify other people (a share, a comment, a document step). Pushes
 * the notifications the caller caused in the last 5 minutes that were not
 * pushed yet to the recipients' devices. Only the caller's own rows are
 * read (actor_id), each is pushed once (notification_push_log), and device
 * keys never leave the server.
 */
export async function POST(request: NextRequest) {
  const origin = request.nextUrl.origin;
  if (!vapidDetails(origin)) return json({ sent: 0, reason: "push is not configured" });

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return json({ error: "Unauthorized" }, 401);

  let admin: ReturnType<typeof createAdminClient>;
  try {
    admin = createAdminClient();
  } catch {
    return json({ sent: 0, reason: "push is not configured" });
  }

  const since = new Date(Date.now() - MAX_AGE_MS).toISOString();
  const columns = "id, user_id, title, body, link, kind";
  // rows without a push log entry (anti-join on the embedded table)
  const pending = await admin
    .from("notifications")
    .select(`${columns}, notification_push_log(notification_id)`)
    .eq("actor_id", user.id)
    .gt("created_at", since)
    .is("notification_push_log", null)
    .order("created_at", { ascending: true })
    .limit(BATCH);

  let rows: PushableNotification[];
  if (!pending.error) {
    rows = ((pending.data ?? []) as PushableNotification[]).map((r) => ({
      id: r.id,
      user_id: r.user_id,
      title: r.title,
      body: r.body,
      link: r.link,
      kind: r.kind,
    }));
  } else {
    // fallback without the embed: recent rows minus the ones already pushed
    const { data: recent, error } = await admin
      .from("notifications")
      .select(columns)
      .eq("actor_id", user.id)
      .gt("created_at", since)
      .order("created_at", { ascending: false })
      .limit(BATCH);
    if (error) return json({ error: "Could not load notifications" }, 500);
    const ids = (recent ?? []).map((r) => r.id as string);
    const { data: pushed } = ids.length
      ? await admin.from("notification_push_log").select("notification_id").in("notification_id", ids)
      : { data: [] };
    const done = new Set((pushed ?? []).map((p) => p.notification_id as string));
    rows = ((recent ?? []) as PushableNotification[]).filter((r) => !done.has(r.id));
  }
  if (rows.length === 0) return json({ sent: 0 });

  const { sent, gone } = await pushNotificationRows(admin, rows, origin);
  return json({ sent, removed: gone });
}
