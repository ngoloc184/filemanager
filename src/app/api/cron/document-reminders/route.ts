import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isCronAuthorized } from "@/lib/cron-auth";
import { pushNotificationRows, type PushableNotification } from "@/lib/push/send-notifications";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** notification ids per lookup (keeps the PostgREST URL short) */
const LOOKUP_BATCH = 200;

const json = (body: Record<string, unknown>, status = 200) =>
  NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

type Admin = ReturnType<typeof createAdminClient>;

/** Loads the rows Web Push needs for the given notification ids. */
async function loadNotifications(admin: Admin, ids: string[]): Promise<PushableNotification[]> {
  const rows: PushableNotification[] = [];
  for (let i = 0; i < ids.length; i += LOOKUP_BATCH) {
    const { data, error } = await admin
      .from("notifications")
      .select("id, user_id, title, body, link, kind")
      .in("id", ids.slice(i, i + LOOKUP_BATCH));
    if (error) {
      // the bell still shows them; only the device push is skipped
      console.warn("cron document-reminders: notification lookup failed", error.code || "error");
      continue;
    }
    rows.push(...((data ?? []) as PushableNotification[]));
  }
  return rows;
}

/**
 * GET|POST /api/cron/document-reminders — daily deadline reminders, called by
 * Vercel Cron (GET with `Authorization: Bearer $CRON_SECRET`) or another
 * scheduler (`x-cron-secret`). run_document_reminders notifies assignees of
 * work due tomorrow, due today or overdue (at most once per assignment, kind
 * and day, so a retry sends nothing twice); the new notifications are then
 * pushed to the recipients' devices. Returns only counts.
 */
async function handle(request: NextRequest) {
  if (!isCronAuthorized(request.headers, process.env.CRON_SECRET)) {
    return json({ error: "Unauthorized" }, 401);
  }

  let admin: Admin;
  try {
    admin = createAdminClient();
  } catch {
    return json({ error: "Reminders are not configured" }, 503);
  }

  const reminders = await admin.rpc("run_document_reminders");
  if (reminders.error) {
    console.error("cron document-reminders: run_document_reminders failed", reminders.error.code || "error");
    return json({ error: "Reminders failed" }, 500);
  }
  const ids = [
    ...new Set(
      ((reminders.data ?? []) as { notification_id: string | null }[])
        .map((row) => row.notification_id)
        .filter((id): id is string => Boolean(id))
    ),
  ];

  let sent = 0;
  if (ids.length > 0) {
    const rows = await loadNotifications(admin, ids);
    try {
      ({ sent } = await pushNotificationRows(admin, rows, request.nextUrl.origin));
    } catch (error) {
      console.warn(
        "cron document-reminders: push failed",
        error instanceof Error ? error.name : "error"
      );
    }
  }

  const result = { notifications: ids.length, sent };
  console.info(JSON.stringify({ event: "cron.document_reminders", ...result }));
  return json(result);
}

export const GET = handle;
export const POST = handle;
