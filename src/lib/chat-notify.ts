// Pure helpers for chat notifications (unit-tested): which channel a new
// message uses, and what the system notification says.

export type NotifyPermission = NotificationPermission | "unsupported";

/**
 * - in-app toast: a message from someone else that is not the open conversation
 * - system (device) notification: the account switch is on, this browser
 *   allowed it, and the message is not the conversation on screen; also while
 *   the app is in use. When this browser has a Web Push subscription the
 *   service worker shows it (it also arrives with the app closed), so the page
 *   does not show a second one.
 * Edits and unsends (UPDATE/DELETE) and my own messages never notify.
 */
export function notifyChannels(input: {
  event: string;
  senderId: string;
  myId: string;
  onScreen: boolean;
  pageActive: boolean;
  enabled: boolean;
  permission: NotifyPermission;
  pushActive?: boolean;
}): { toast: boolean; system: boolean } {
  if (input.event !== "INSERT" || input.senderId === input.myId) return { toast: false, system: false };
  const watching = input.onScreen && input.pageActive;
  return {
    toast: !input.onScreen,
    system: input.enabled && input.permission === "granted" && !watching && !input.pushActive,
  };
}

const PREVIEW_MAX = 140;

/**
 * Title (the sender, or the group) and a one-line preview of the message.
 * `senderEmail` is the sender's display name or e-mail.
 */
export function notificationContent(message: {
  senderEmail: string | null;
  body: string | null;
  fileName: string | null;
  group?: string | null;
  mentioned?: boolean;
  sticker?: boolean;
}): { title: string; body: string } {
  const text = message.body?.replace(/\s+/g, " ").trim();
  let body = text || (message.fileName ? `📎 ${message.fileName}` : message.sticker ? "Sent a sticker" : "Sent you a message");
  const sender = message.senderEmail ?? "Someone";
  if (message.mentioned) body = `${sender} mentioned you: ${body}`;
  else if (message.group) body = `${sender}: ${body}`;
  if (body.length > PREVIEW_MAX) body = `${body.slice(0, PREVIEW_MAX - 1)}…`;
  return { title: message.group || message.senderEmail || "New chat message", body };
}

export type ChatPushPayload = { title: string; body: string; tag: string; conversationId: string };

/** What a Web Push carries for one recipient (shown by public/sw.js). */
export function chatPushPayload(input: {
  message: {
    id: string;
    conversation_id: string;
    body: string | null;
    file_name: string | null;
    mentions: string[] | null;
    meta?: { sticker?: string } | null;
  };
  senderName: string;
  group: string | null;
  recipientId: string;
}): ChatPushPayload {
  const content = notificationContent({
    senderEmail: input.senderName,
    body: input.message.body,
    fileName: input.message.file_name,
    group: input.group,
    mentioned: (input.message.mentions ?? []).includes(input.recipientId),
    sticker: Boolean(input.message.meta?.sticker),
  });
  return { ...content, tag: `chat-${input.message.id}`, conversationId: input.message.conversation_id };
}
