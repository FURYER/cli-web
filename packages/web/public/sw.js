/* global self, clients */
self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  event.waitUntil(
    (async () => {
      let data = {
        title: "WebCLI",
        body: "Agent finished",
        tag: "webcli-done",
        sessionId: undefined,
      };
      try {
        if (event.data) {
          data = { ...data, ...event.data.json() };
        }
      } catch {
        try {
          const text = event.data?.text();
          if (text) data.body = text;
        } catch {
          /* ignore */
        }
      }

      const sessionId = data.sessionId || undefined;
      const windows = await clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });

      // Wake frozen PWAs: queue a resync even if the user opens the app by hand
      // later (notification click is not required).
      for (const client of windows) {
        try {
          client.postMessage({
            type: "webcli:resync",
            sessionId,
          });
        } catch {
          /* ignore */
        }
      }

      const looking = windows.some(
        (client) => client.visibilityState === "visible" && client.focused,
      );
      if (looking) return;

      const url = sessionId
        ? `/?session=${encodeURIComponent(sessionId)}`
        : "/";

      await self.registration.showNotification(data.title || "WebCLI", {
        body: data.body || "",
        tag: data.tag || "webcli-done",
        renotify: true,
        data: { url, sessionId },
      });
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const sessionId = event.notification.data?.sessionId;
  const target =
    event.notification.data?.url ||
    (sessionId ? `/?session=${encodeURIComponent(sessionId)}` : "/");
  event.waitUntil(
    (async () => {
      const all = await clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of all) {
        try {
          client.postMessage({ type: "webcli:resync" });
          if (sessionId) {
            client.postMessage({
              type: "webcli:open-session",
              sessionId,
            });
          }
        } catch {
          /* ignore */
        }
        if ("focus" in client) {
          await client.focus();
          return;
        }
      }
      if (clients.openWindow) {
        await clients.openWindow(target);
      }
    })(),
  );
});
