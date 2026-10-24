// Service worker for chat notifications. It only shows notifications (Android
// Chrome and installed iOS web apps cannot use `new Notification()`) and opens
// the conversation when one is clicked. It does not intercept requests.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

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
