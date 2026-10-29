import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { chatPushPayload } from "@/lib/chat-notify";
import { sendPush, vapidDetails, type PushTarget } from "@/lib/push/web-push";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** a message is pushed only shortly after it was sent */
const MAX_AGE_MS = 5 * 60 * 1000;

const json = (body: Record<string, unknown>, status = 200) =>
  NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

/**
 * POST /api/push/chat {"messageId"} — called by the sender's app right after
 * a message was saved. Sends it as a Web Push to the devices of the other
 * members who turned chat notifications on, so it arrives even when their
 * app is closed. Each message is pushed once (chat_push_log); only its sender
 * can trigger it; device keys are read with the service role and never leave
 * the server.
 */
export async function POST(request: NextRequest) {
  const vapid = vapidDetails(request.nextUrl.origin);
  if (!vapid) return json({ sent: 0, reason: "push is not configured" });

  const body = (await request.json().catch(() => null)) as { messageId?: unknown } | null;
  const messageId = typeof body?.messageId === "string" ? body.messageId : "";
  if (!UUID.test(messageId)) return json({ error: "messageId is required" }, 400);

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return json({ error: "Unauthorized" }, 401);

  const admin = createAdminClient();
  const { data: message } = await admin
    .from("chat_messages")
    .select("id, conversation_id, sender_id, kind, body, file_name, mentions, meta, created_at, deleted_at")
    .eq("id", messageId)
    .maybeSingle();
  if (!message || message.sender_id !== user.id || message.kind !== "message" || message.deleted_at) {
    return json({ error: "Message not found" }, 404);
  }
  if (Date.now() - Date.parse(message.created_at) > MAX_AGE_MS) return json({ sent: 0, reason: "too old" });

  // once per message, whoever calls
  const { error: logError } = await admin.from("chat_push_log").insert({ message_id: message.id });
  if (logError) return json({ sent: 0, reason: logError.code === "23505" ? "already pushed" : "log failed" });

  const [{ data: conversation }, { data: members }, { data: sender }] = await Promise.all([
    admin.from("chat_conversations").select("kind, title").eq("id", message.conversation_id).maybeSingle(),
    admin.from("chat_members").select("user_id").eq("conversation_id", message.conversation_id),
    admin.from("user_profiles").select("email, display_name").eq("id", user.id).maybeSingle(),
  ]);
  const others = (members ?? []).map((m) => m.user_id as string).filter((id) => id !== user.id);
  if (!others.length) return json({ sent: 0 });

  const [{ data: prefs }, { data: subscriptions }] = await Promise.all([
    admin.from("user_preferences").select("user_id").in("user_id", others).eq("chat_notifications", true),
    admin.from("push_subscriptions").select("id, user_id, endpoint, p256dh, auth").in("user_id", others),
  ]);
  const enabled = new Set((prefs ?? []).map((p) => p.user_id as string));
  const targets = ((subscriptions ?? []) as (PushTarget & { user_id: string })[]).filter((s) => enabled.has(s.user_id));
  if (!targets.length) return json({ sent: 0 });

  const senderName = (sender?.display_name as string | null) || (sender?.email as string | null) || "Someone";
  const group = conversation?.kind === "group" ? ((conversation.title as string | null) ?? "Group") : null;
  const results = await Promise.all(
    targets.map((target) =>
      sendPush(target, chatPushPayload({ message, senderName, group, recipientId: target.user_id }), vapid).then((result) => ({ target, result }))
    )
  );

  const gone = results.filter((r) => r.result === "gone").map((r) => r.target.id);
  const sent = results.filter((r) => r.result === "sent").map((r) => r.target.id);
  await Promise.all([
    gone.length ? admin.from("push_subscriptions").delete().in("id", gone) : null,
    sent.length ? admin.from("push_subscriptions").update({ last_used_at: new Date().toISOString() }).in("id", sent) : null,
  ]);
  return json({ sent: sent.length, removed: gone.length, failed: results.length - sent.length - gone.length });
}
