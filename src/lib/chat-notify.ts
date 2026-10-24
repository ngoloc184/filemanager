// Pure helpers for chat notifications (unit-tested): which channel a new
// message uses, and what the system notification says.

export type NotifyPermission = NotificationPermission | "unsupported";

/**
 * - in-app toast: a message from someone else that is not the open conversation
 * - system notification: the account switch is on, this browser allowed it,
 *   and the user is not looking at the app (tab hidden or window not focused)
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
}): { toast: boolean; system: boolean } {
  if (input.event !== "INSERT" || input.senderId === input.myId) return { toast: false, system: false };
  return {
    toast: !input.onScreen,
    system: input.enabled && input.permission === "granted" && !input.pageActive,
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
}): { title: string; body: string } {
  const text = message.body?.replace(/\s+/g, " ").trim();
  let body = text || (message.fileName ? `📎 ${message.fileName}` : "Sent you a message");
  const sender = message.senderEmail ?? "Someone";
  if (message.mentioned) body = `${sender} mentioned you: ${body}`;
  else if (message.group) body = `${sender}: ${body}`;
  if (body.length > PREVIEW_MAX) body = `${body.slice(0, PREVIEW_MAX - 1)}…`;
  return { title: message.group || message.senderEmail || "New chat message", body };
}
