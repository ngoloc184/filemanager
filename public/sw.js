// Service worker for chat notifications. It shows Web Push messages (they
// arrive even when the app is closed), shows notifications for the page
// (Android Chrome and installed iOS web apps cannot use `new Notification()`),
// and opens the conversation when one is clicked. It does not intercept requests.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

// conversation on screen in each open tab (sent by the page)
const onScreen = new Map();

self.addEventListener("message", (event) => {
  const data = event.data;
  if (data && data.type === "chat-state" && event.source && event.source.id) {
    onScreen.set(event.source.id, typeof data.conversationId === "string" ? data.conversationId : null);
  }
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : "" };
  }
  const conversationId = typeof data.conversationId === "string" ? data.conversationId : null;
  const tag = typeof data.tag === "string" ? data.tag : undefined;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const reading = windows.some(
        (client) => client.focused && client.visibilityState === "visible" && conversationId && onScreen.get(client.id) === conversationId
      );
      // browsers require a notification for every push; when the user is
      // reading that conversation it is closed again right away
      await self.registration.showNotification(data.title || "New message", {
        body: data.body || "",
        tag,
        icon: "/apple-icon.png",
        data: { conversationId },
      });
      if (reading && tag) {
        const shown = await self.registration.getNotifications({ tag });
        shown.forEach((notification) => notification.close());
      }
    })()
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const conversationId = event.notification.data?.conversationId ?? null;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const open = windows.find((client) => new URL(client.url).origin === self.location.origin);
      if (open) {
        await open.focus();
        open.postMessage({ type: "open-chat", conversationId });
        return;
      }
      const path = conversationId ? `/dashboard?chat=${encodeURIComponent(conversationId)}` : "/dashboard";
      await self.clients.openWindow(path);
    })()
  );
});
