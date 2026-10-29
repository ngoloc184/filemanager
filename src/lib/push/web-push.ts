import "server-only";
import webpush, { WebPushError } from "web-push";

/**
 * Web Push sender (VAPID). Configured with NEXT_PUBLIC_VAPID_PUBLIC_KEY,
 * VAPID_PRIVATE_KEY and optionally VAPID_SUBJECT (mailto: or https: contact
 * for the push services; defaults to the site's address). Generate the keys
 * with `npm run push:keys`.
 */
export function vapidDetails(origin: string): { subject: string; publicKey: string; privateKey: string } | null {
  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) return null;
  const subject = process.env.VAPID_SUBJECT || (origin.startsWith("https://") ? origin : "mailto:notifications@example.com");
  return { subject, publicKey, privateKey };
}

export type PushTarget = { id: string; endpoint: string; p256dh: string; auth: string };

/** Sends one push; "gone" means the browser unsubscribed (remove it). */
export async function sendPush(
  target: PushTarget,
  payload: unknown,
  vapid: { subject: string; publicKey: string; privateKey: string }
): Promise<"sent" | "gone" | "failed"> {
  try {
    await webpush.sendNotification({ endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } }, JSON.stringify(payload), {
      vapidDetails: vapid,
      TTL: 60 * 60,
      urgency: "high",
    });
    return "sent";
  } catch (err) {
    if (err instanceof WebPushError && (err.statusCode === 404 || err.statusCode === 410)) return "gone";
    return "failed";
  }
}
