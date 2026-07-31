/**
 * Firebase Cloud Messaging service worker
 * Handles background push and notification click → open consent pending tab
 */
self.__HUSHH_FCM_DEFAULT_TARGET__ = "/consents?tab=pending";

async function broadcastToClients(payload) {
  const clientList = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });
  clientList.forEach((client) => {
    try {
      client.postMessage(payload);
    } catch (_) {
      // Ignore diagnostic message delivery failures.
    }
  });
}

async function focusOrOpenClient(url) {
  const clientList = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });
  for (let index = 0; index < clientList.length; index += 1) {
    const client = clientList[index];
    if (!client || !("focus" in client)) continue;
    if ("navigate" in client) {
      try {
        await client.navigate(url);
      } catch (_) {
        // Fall through to focus/open if navigate is rejected.
      }
    }
    return client.focus();
  }
  if (self.clients.openWindow) {
    return self.clients.openWindow(url);
  }
  return undefined;
}

self.addEventListener("push", function (event) {
  if (!event.data) return;
  try {
    const data = event.data.json();
    const title = data.notification?.title || data.title || "Consent request";
    const body =
      data.notification?.body || data.body || "You have a new consent request";
    const url =
      data.data?.request_url ||
      data.data?.deep_link ||
      data.data?.url ||
      data.fcmOptions?.link ||
      data.webpush?.fcmOptions?.link ||
      data.url ||
      "/consents?tab=pending";
    const tag =
      data.data?.notification_tag ||
      data.notification?.tag ||
      "consent-request";
    const requireInteraction =
      data.notification?.requireInteraction ?? true;
    const notificationOptions = {
      body,
      data: { url },
      tag,
      requireInteraction,
    };
    event.waitUntil(
      (async () => {
        await broadcastToClients({
          type: "hushh:fcm_push_received",
          title,
          body,
          url,
          tag,
          requireInteraction,
        });
        await self.registration.showNotification(title, notificationOptions);
      })()
    );
  } catch (_) {
    event.waitUntil(
      (async () => {
        const fallback = {
          title: "Consent request",
          body: "You have a new consent request",
          url: self.__HUSHH_FCM_DEFAULT_TARGET__,
          tag: "consent-request",
          requireInteraction: true,
        };
        await broadcastToClients({
          type: "hushh:fcm_push_received",
          ...fallback,
        });
        await self.registration.showNotification(fallback.title, {
          body: fallback.body,
          data: { url: fallback.url },
          tag: fallback.tag,
          requireInteraction: fallback.requireInteraction,
        });
      })()
    );
  }
});

self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  const url =
    event.notification.data?.url || self.__HUSHH_FCM_DEFAULT_TARGET__;
  event.waitUntil(
    (async () => {
      await broadcastToClients({
        type: "hushh:fcm_notification_clicked",
        url,
        reason: "notification_click",
      });
      return focusOrOpenClient(url);
    })()
  );
});

self.addEventListener("message", function (event) {
  const data = event.data || {};
  if (data.type !== "hushh:test_notification_click") {
    return;
  }
  const url = data.url || self.__HUSHH_FCM_DEFAULT_TARGET__;
  event.waitUntil(
    (async () => {
      await broadcastToClients({
        type: "hushh:fcm_notification_clicked",
        url,
        reason: "test_click",
      });
      return focusOrOpenClient(url);
    })()
  );
});
