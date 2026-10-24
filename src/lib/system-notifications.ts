// Browser (system) notifications: permission, the service worker that shows
// them, and clicks. Browser-only.
import type { NotifyPermission } from "@/lib/chat-notify";

export function notificationPermission(): NotifyPermission {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  return Notification.permission;
}

/** Must be called from a click (browsers ignore requests made without one). */
export async function requestNotificationPermission(): Promise<NotifyPermission> {
  if (notificationPermission() === "unsupported") return "unsupported";
  return Notification.requestPermission();
}

let worker: Promise<ServiceWorkerRegistration | null> | null = null;

/** Registers /sw.js once; null where service workers are not available. */
export function notificationWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!worker) {
    worker =
      typeof navigator !== "undefined" && "serviceWorker" in navigator
        ? navigator.serviceWorker.register("/sw.js").then(() => navigator.serviceWorker.ready).catch(() => null)
        : Promise.resolve(null);
  }
  return worker;
}

/**
 * Shows a system notification. The same `tag` replaces an earlier one, so a
 * message seen by several open tabs is shown once.
 */
export async function showSystemNotification(
  notification: { title: string; body: string; tag: string; conversationId: string },
  onClick: () => void
): Promise<void> {
  const options: NotificationOptions = {
    body: notification.body,
    tag: notification.tag,
    icon: "/apple-icon.png",
    data: { conversationId: notification.conversationId },
  };
  const registration = await notificationWorker();
  if (registration) {
    await registration.showNotification(notification.title, options);
    return;
  }
  const shown = new Notification(notification.title, options);
  shown.onclick = () => {
    window.focus();
    onClick();
    shown.close();
  };
}

/** A notification shown by the service worker was clicked: open that chat. */
export function onNotificationClick(open: (conversationId: string) => void): () => void {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return () => {};
  const listener = (event: MessageEvent) => {
    const data = event.data as { type?: string; conversationId?: unknown } | null;
    if (data?.type === "open-chat" && typeof data.conversationId === "string") open(data.conversationId);
  };
  navigator.serviceWorker.addEventListener("message", listener);
  return () => navigator.serviceWorker.removeEventListener("message", listener);
}

/** The user is looking at the app: the tab is visible and the window focused. */
export function pageActive(): boolean {
  return document.visibilityState === "visible" && document.hasFocus();
}
