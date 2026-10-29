// Web Push in the browser: subscribe this device (after the user allowed
// notifications), save the subscription for the account, remove it at
// sign-out, and ask the server to push a message just sent. Browser-only.

import { createClient } from "@/lib/supabase/client";
import { notificationWorker } from "@/lib/system-notifications";

const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? "";

let active = false;

/** This device receives Web Push (so the page itself does not show notifications). */
export function pushActive(): boolean {
  return active;
}

export function pushSupported(): boolean {
  return (
    Boolean(VAPID_PUBLIC_KEY) &&
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const padded = (base64url + "=".repeat((4 - (base64url.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

function sameKey(current: ArrayBuffer | null | undefined, expected: Uint8Array): boolean {
  if (!current) return false;
  const a = new Uint8Array(current);
  return a.length === expected.length && a.every((b, i) => b === expected[i]);
}

/**
 * Subscribes this browser (permission must be granted) and saves it for the
 * signed-in account. Safe to call on every visit: it reuses the subscription.
 */
export async function ensurePushSubscription(): Promise<boolean> {
  if (!pushSupported() || Notification.permission !== "granted") return false;
  try {
    const registration = await notificationWorker();
    if (!registration) return false;
    const key = keyBytes(VAPID_PUBLIC_KEY);
    let subscription = await registration.pushManager.getSubscription();
    // a subscription made with other keys (keys rotated) cannot receive our pushes
    if (subscription && !sameKey(subscription.options.applicationServerKey, key)) {
      await subscription.unsubscribe();
      subscription = null;
    }
    subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    const { endpoint, keys } = subscription.toJSON();
    if (!endpoint || !keys?.p256dh || !keys.auth) return false;
    const { error } = await createClient().rpc("save_push_subscription", {
      p_endpoint: endpoint,
      p_p256dh: keys.p256dh,
      p_auth: keys.auth,
      p_user_agent: navigator.userAgent.slice(0, 300),
    });
    active = !error;
    return active;
  } catch {
    active = false;
    return false;
  }
}

/** Sign-out: this browser stops receiving the account's messages. */
export async function removePushSubscription(): Promise<void> {
  active = false;
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    const subscription = await registration?.pushManager.getSubscription();
    if (!subscription) return;
    await createClient().rpc("delete_push_subscription", { p_endpoint: subscription.endpoint });
    await subscription.unsubscribe();
  } catch {
    // best effort: the server also drops subscriptions the browser gave up
  }
}

/** Asks the server to push a message just sent to the other members' devices. */
export function pushMessage(messageId: string): void {
  if (!VAPID_PUBLIC_KEY) return;
  void fetch("/api/push/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messageId }),
    // still delivered when the tab closes right after sending
    keepalive: true,
  }).catch(() => undefined);
}
