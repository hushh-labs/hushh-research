/**
 * Firebase Cloud Messaging service worker
 * Handles background push and notification click → open consent pending tab
 */
self.__HUSHH_FCM_DEFAULT_TARGET__ = "/one/consent?tab=pending";
const pendingForegroundDeliveryAcks = new Map();

function nextDeliveryId() {
  if (self.crypto?.randomUUID) return self.crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function waitForForegroundDeliveryAck(deliveryId) {
  const timeoutMs = self.__HUSHH_FCM_ACK_TIMEOUT_MS__ || 750;
  return new Promise((resolve) => {
    const finish = (acknowledged) => {
      pendingForegroundDeliveryAcks.delete(deliveryId);
      clearTimeout(timeoutId);
      resolve(acknowledged);
    };
    const timeoutId = setTimeout(() => finish(false), timeoutMs);
    pendingForegroundDeliveryAcks.set(deliveryId, () => finish(true));
  });
}

function isHandledByVisibleApp(data) {
  const type = String(data?.type || "")
    .trim()
    .toLowerCase();
  return (
    type.startsWith("location_") ||
    type === "consent_request" ||
    type === "consent_opened" ||
    type === "consent_resolved"
  );
}

function isEmergencySmsAlert(data) {
  const profile = String(data?.notification_profile || "")
    .trim()
    .toLowerCase();
  if (profile === "one_location_sms_emergency") return true;
  return (
    String(data?.type || "")
      .trim()
      .toLowerCase() === "location_share_created" &&
    String(data?.share_kind || "")
      .trim()
      .toLowerCase() === "sos"
  );
}

async function broadcastToClients(payload) {
  const clientList = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });
  let visibleClientCount = 0;
  clientList.forEach((client) => {
    if (client.visibilityState === "visible") visibleClientCount += 1;
    try {
      client.postMessage(payload);
    } catch (_) {
      // Ignore diagnostic message delivery failures.
    }
  });
  return visibleClientCount;
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
      "/one/consent?tab=pending";
    const tag =
      data.data?.notification_tag ||
      data.notification?.tag ||
      "consent-request";
    const requireInteraction = data.notification?.requireInteraction ?? true;
    const isEmergencySms = isEmergencySmsAlert(data.data);
    const notificationOptions = {
      body,
      data: { ...(data.data || {}), url },
      tag,
      requireInteraction,
      icon: "/hushh_icon.png",
      renotify: isEmergencySms,
      silent: false,
      vibrate: isEmergencySms ? [240, 120, 240, 120, 520] : undefined,
    };
    event.waitUntil(
      (async () => {
        const handledByVisibleApp = isHandledByVisibleApp(data.data);
        const deliveryId = handledByVisibleApp ? nextDeliveryId() : "";
        const deliveryAck = deliveryId
          ? waitForForegroundDeliveryAck(deliveryId)
          : Promise.resolve(false);
        const visibleClientCount = await broadcastToClients({
          type: "hushh:fcm_push_received",
          delivery_id: deliveryId,
          title,
          body,
          url,
          tag,
          requireInteraction,
          data: data.data || {},
        });
        const acknowledged =
          visibleClientCount > 0 && handledByVisibleApp
            ? await deliveryAck
            : false;
        // Suppress the browser notification only after the visible app bridge
        // confirms receipt. Otherwise the system tray remains the reliable fallback.
        if (!acknowledged) {
          await self.registration.showNotification(title, notificationOptions);
        }
      })(),
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
        const visibleClientCount = await broadcastToClients({
          type: "hushh:fcm_push_received",
          ...fallback,
          data: {},
        });
        await self.registration.showNotification(fallback.title, {
          body: fallback.body,
          data: { url: fallback.url },
          tag: fallback.tag,
          requireInteraction: fallback.requireInteraction,
        });
      })(),
    );
  }
});

self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  const url = event.notification.data?.url || self.__HUSHH_FCM_DEFAULT_TARGET__;
  event.waitUntil(
    (async () => {
      await broadcastToClients({
        type: "hushh:fcm_notification_clicked",
        url,
        reason: "notification_click",
      });
      return focusOrOpenClient(url);
    })(),
  );
});

self.addEventListener("message", function (event) {
  const data = event.data || {};
  if (data.type === "hushh:fcm_push_ack") {
    const acknowledge = pendingForegroundDeliveryAcks.get(data.delivery_id);
    if (acknowledge) acknowledge();
    return;
  }
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
    })(),
  );
});
