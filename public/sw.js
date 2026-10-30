// Service worker for notifications. It shows Web Push messages (they arrive
// even when the app is closed): chat messages, and activity notifications
// (shares, comments, documents) from the notification center. It also shows
// notifications for the page (Android Chrome and installed iOS web apps
// cannot use `new Notification()`), and opens the conversation or the linked
// page when one is clicked. It does not intercept requests.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

// conversation on screen in each open tab (sent by the page)
const onScreen = new Map();

// signed-in app pages: a tab on one of these has the chat widget and can be
// sent to another page of the app
const DASHBOARD_ROUTES = [
  "/dashboard",
  "/documents",
  "/org",
  "/shared",
  "/recent",
  "/search",
  "/activity",
  "/trash",
  "/links",
  "/contacts",
  "/notifications",
];

function isDashboardPath(pathname) {
  return DASHBOARD_ROUTES.some((route) => pathname === route || pathname.startsWith(route + "/"));
}

/** The same-origin URL for an in-app path, or null ("//host", "/\host", full URLs). */
function appUrl(path) {
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//") || path.startsWith("/\\")) return null;
  for (let i = 0; i < path.length; i++) {
    if (path.charCodeAt(i) < 0x20 || path.charCodeAt(i) === 0x7f) return null;
  }
  try {
    const url = new URL(path, self.location.origin);
    return url.origin === self.location.origin ? url.href : null;
  } catch {
    return null;
  }
}

/** An open tab of the app on a signed-in page, the focused one first. */
async function dashboardWindow() {
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const candidates = windows.filter((client) => {
    try {
      const url = new URL(client.url);
      return url.origin === self.location.origin && isDashboardPath(url.pathname);
    } catch {
      return false;
    }
  });
  return candidates.find((client) => client.focused) || candidates[0] || null;
}

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

  // notification center (shares, comments, documents)
  if (data && data.type === "notification") {
    const url = appUrl(data.url) ? data.url : "/dashboard";
    event.waitUntil(
      self.registration.showNotification(data.title || "New notification", {
        body: data.body || "",
        tag: typeof data.tag === "string" ? data.tag : undefined,
        icon: "/apple-icon.png",
        data: { url },
      })
    );
    return;
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
  const data = event.notification.data || {};

  // notification center: open the linked page in an app tab, or a new one
  if (typeof data.url === "string") {
    const url = appUrl(data.url) || appUrl("/dashboard");
    event.waitUntil(
      (async () => {
        const open = await dashboardWindow();
        if (open) {
          try {
            await open.focus();
            await open.navigate(url);
            return;
          } catch {
            // a tab this worker does not control cannot be navigated
          }
        }
        await self.clients.openWindow(url);
      })()
    );
    return;
  }

  // chat: the app tab opens the conversation (chat widget, "open-chat");
  // without one, /dashboard?chat=<id> opens it on load
  const conversationId = data.conversationId ?? null;
  event.waitUntil(
    (async () => {
      const open = await dashboardWindow();
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
