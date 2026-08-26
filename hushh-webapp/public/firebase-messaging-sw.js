/**
 * Firebase Cloud Messaging service worker
 * Handles background push and notification click → open the Feed
 */
self.__HUSHH_FCM_DEFAULT_TARGET__ = "/one/feed";
const pendingForegroundDeliveryAcks = new Map();
const pendingNotificationClickAcks = new Map();

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

function waitForNotificationClickAck(clickId) {
  const timeoutMs = self.__HUSHH_FCM_ACK_TIMEOUT_MS__ || 750;
  return new Promise((resolve) => {
    const finish = (acknowledged) => {
      pendingNotificationClickAcks.delete(clickId);
      clearTimeout(timeoutId);
      resolve(acknowledged);
    };
    const timeoutId = setTimeout(() => finish(false), timeoutMs);
    pendingNotificationClickAcks.set(clickId, finish);
  });
}

function isSilentNotification(data) {
  const presentation = String(data?.notification_presentation || "")
    .trim()
    .toLowerCase();
  if (presentation === "silent") return true;
  if (presentation === "alert") return false;

  // Backward compatibility while older backend revisions can still deliver
  // consent bookkeeping messages without the explicit presentation field.
  const type = String(data?.type || "")
    .trim()
    .toLowerCase();
  return type === "consent_opened" || type === "consent_resolved";
}

function feedNotificationTarget(data) {
  const type = String(data?.type || "")
    .trim()
    .toLowerCase();
  if (type !== "consent_request") {
    return self.__HUSHH_FCM_DEFAULT_TARGET__;
  }

  const params = [];
  const requestId = String(data?.request_id || "").trim();
  const bundleId = String(data?.bundle_id || "").trim();
  if (requestId) {
    params.push(`notificationRequestId=${encodeURIComponent(requestId)}`);
  }
  if (bundleId) {
    params.push(`notificationBundleId=${encodeURIComponent(bundleId)}`);
  }
  return params.length
    ? `${self.__HUSHH_FCM_DEFAULT_TARGET__}?${params.join("&")}`
    : self.__HUSHH_FCM_DEFAULT_TARGET__;
}

async function closeDeliveredNotificationTag(tag) {
  if (!tag || typeof self.registration.getNotifications !== "function") {
    return;
  }
  try {
    const notifications = await self.registration.getNotifications({ tag });
    notifications.forEach((notification) => notification.close());
  } catch (_) {
    // Closing a stale banner is cleanup only; never let it block state refresh.
  }
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

async function deliverPushToClients(payload) {
  const clientList = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });
  const visibleClients = clientList.filter(
    (client) => client.visibilityState === "visible",
  );
  const owner =
    visibleClients.find((client) => client.focused === true) ||
    visibleClients[0] ||
    null;

  clientList.forEach((client) => {
    try {
      client.postMessage(
        client === owner
          ? payload
          : {
              type: "hushh:fcm_feed_changed",
              reason: "push_received",
            },
      );
    } catch (_) {
      // Feed also repairs itself on focus/poll; system delivery remains the
      // fallback if the selected visible owner cannot acknowledge.
    }
  });
  return owner ? 1 : 0;
}

async function routeNotificationClick(url, reason, data) {
  const clientList = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });
  const client =
    clientList.find((candidate) => candidate.focused === true) ||
    clientList.find((candidate) => candidate.visibilityState === "visible") ||
    clientList.find((candidate) => typeof candidate.focus === "function");
  if (client) {
    if (typeof client.focus === "function") {
      await client.focus();
    }
    const clickId = nextDeliveryId();
    const clickAck = waitForNotificationClickAck(clickId);
    try {
      client.postMessage({
        type: "hushh:fcm_notification_clicked",
        click_id: clickId,
        url,
        reason,
        data: data || {},
      });
    } catch (_) {
      const finish = pendingNotificationClickAcks.get(clickId);
      if (finish) finish(false);
    }
    const acknowledged = await clickAck;
    if (acknowledged) {
      return client;
    }
    if (typeof client.navigate === "function") {
      try {
        const navigated = await client.navigate(url);
        if (navigated) return navigated;
      } catch (_) {
        // Fall through to opening a new Feed window below.
      }
    }
    if (self.clients.openWindow) {
      return self.clients.openWindow(url);
    }
    return client;
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
    const title = data.notification?.title || data.title || "Notification";
    const body =
      data.notification?.body || data.body || "You have a new notification";
    const sourceUrl =
      data.data?.request_url ||
      data.data?.deep_link ||
      data.data?.url ||
      data.fcmOptions?.link ||
      data.webpush?.fcmOptions?.link ||
      data.url ||
      self.__HUSHH_FCM_DEFAULT_TARGET__;
    const url = self.__HUSHH_FCM_DEFAULT_TARGET__;
    const notificationIdentity =
      data.data?.message_id ||
      data.data?.request_id ||
      data.data?.bundle_id ||
      data.data?.grant_id ||
      data.data?.submission_id ||
      data.data?.referral_id ||
      data.data?.connection_id ||
      data.data?.invite_id ||
      data.data?.transfer_id ||
      nextDeliveryId();
    const notificationType = String(data.data?.type || "notification")
      .trim()
      .toLowerCase();
    const tag =
      data.data?.notification_tag ||
      data.notification?.tag ||
      `hussh:${notificationType}:${notificationIdentity}`;
    const requireInteraction = data.notification?.requireInteraction ?? true;
    const isEmergencySms = isEmergencySmsAlert(data.data);
    const isSilent = isSilentNotification(data.data);
    const notificationOptions = {
      body,
      data: { ...(data.data || {}), source_url: sourceUrl, url },
      tag,
      requireInteraction,
      icon: "/hushh_icon.png",
      renotify: isEmergencySms,
      silent: false,
      vibrate: isEmergencySms ? [240, 120, 240, 120, 520] : undefined,
    };
    event.waitUntil(
      (async () => {
        const deliveryId = nextDeliveryId();
        if (isSilent) {
          await closeDeliveredNotificationTag(tag);
          await deliverPushToClients({
            type: "hushh:fcm_push_received",
            delivery_id: deliveryId,
            title,
            body,
            url,
            tag,
            requireInteraction: false,
            data: data.data || {},
          });
          return;
        }
        const deliveryAck = waitForForegroundDeliveryAck(deliveryId);
        const visibleClientCount = await deliverPushToClients({
          type: "hushh:fcm_push_received",
          delivery_id: deliveryId,
          title,
          body,
          url,
          tag,
          requireInteraction,
          data: data.data || {},
        });
        const acknowledged = visibleClientCount > 0 ? await deliveryAck : false;
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
          title: "Notification",
          body: "You have a new notification",
          url: self.__HUSHH_FCM_DEFAULT_TARGET__,
          tag: `hushh:notification:${nextDeliveryId()}`,
          requireInteraction: true,
        };
        const deliveryId = nextDeliveryId();
        const deliveryAck = waitForForegroundDeliveryAck(deliveryId);
        const visibleClientCount = await deliverPushToClients({
          type: "hushh:fcm_push_received",
          ...fallback,
          delivery_id: deliveryId,
          data: {},
        });
        const acknowledged = visibleClientCount > 0 ? await deliveryAck : false;
        if (!acknowledged) {
          await self.registration.showNotification(fallback.title, {
            body: fallback.body,
            data: { url: fallback.url },
            tag: fallback.tag,
            requireInteraction: fallback.requireInteraction,
          });
        }
      })(),
    );
  }
});

self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  const data = event.notification?.data || {};
  const url = feedNotificationTarget(data);
  event.waitUntil(routeNotificationClick(url, "notification_click", data));
});

self.addEventListener("message", function (event) {
  const data = event.data || {};
  if (data.type === "hushh:fcm_push_ack") {
    const acknowledge = pendingForegroundDeliveryAcks.get(data.delivery_id);
    if (acknowledge) acknowledge();
    return;
  }
  if (data.type === "hushh:fcm_notification_click_ack") {
    const acknowledge = pendingNotificationClickAcks.get(data.click_id);
    if (acknowledge) acknowledge(true);
    return;
  }
  if (data.type !== "hushh:test_notification_click") {
    return;
  }
  const url = self.__HUSHH_FCM_DEFAULT_TARGET__;
  event.waitUntil(routeNotificationClick(url, "test_click", {}));
});
