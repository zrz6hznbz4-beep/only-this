/* Only This — service worker.
   Two jobs only: receive pushes and show them, and focus the app when one is tapped.
   Deliberately no offline caching; the app is a single file served fresh each visit,
   and a stale cache would be far more annoying than a slow load. */

const VERSION = "only-this-sw-1";

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: "Only This", body: event.data ? event.data.text() : "" };
  }

  const title = data.title || "Only This";
  const options = {
    body: data.body || "",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    // Same tag per type means a newer notification replaces the older one of that
    // kind rather than stacking up three morning briefs.
    tag: data.tag || "only-this",
    renotify: true,
    data: { url: data.url || "/", type: data.tag || "" },
    // Notifications here are informational, never urgent.
    requireInteraction: false,
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "/";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      // Reuse an open window if there is one, rather than piling up new ones.
      for (const client of list) {
        if ("focus" in client) {
          if ("navigate" in client && client.url !== target) client.navigate(target);
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(target);
      return undefined;
    })
  );
});

// If the browser rotates the subscription, tell the server the new endpoint so
// notifications don't silently stop.
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    (async () => {
      try {
        const old = event.oldSubscription || null;
        const fresh =
          event.newSubscription ||
          (await self.registration.pushManager.subscribe(
            event.oldSubscription ? event.oldSubscription.options : { userVisibleOnly: true }
          ));
        await fetch("/api/push", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "replace",
            oldEndpoint: old ? old.endpoint : null,
            subscription: fresh,
          }),
        });
      } catch (e) {
        /* nothing sensible to do here */
      }
    })()
  );
});
