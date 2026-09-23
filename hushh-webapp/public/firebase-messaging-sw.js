/**
 * Firebase Cloud Messaging service worker
 * Handles background push and notification clicks into the owning app surface.
 */
self.__HUSHH_FCM_DEFAULT_TARGET__ = "/one/feed";
const pendingForegroundDeliveryAcks = new Map();
const pendingNotificationClickAcks = new Map();
// Keep this closed vocabulary and UUID rule aligned with
// lib/consent/document-share-consent.ts. A document-share push is only a
// wake-up signal; raw provider URLs and file/recipient details never leave
// this worker or choose a navigation target.
const DOCUMENT_SHARE_NOTIFICATION_TYPES = new Set([
  "document_share_request",
  "document_share_review_ready",
  "document_share_decided",
  "document_share_outcome",
  "document_share_revoked",
  "document_share_revocation_outcome",
]);
const DOCUMENT_REQUEST_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DOCUMENT_SHARE_NOTIFICATION_COPY = {
  title: "Document request",
  body: "Open One to review.",
};

function normalizedDocumentShareType(data) {
  return typeof data?.type === "string" ? data.type.trim().toLowerCase() : "";
}

function isDocumentShareNotificationType(data) {
  return DOCUMENT_SHARE_NOTIFICATION_TYPES.has(
    normalizedDocumentShareType(data),
  );
}

function isDocumentShareNotificationCandidate(data) {
  return normalizedDocumentShareType(data).startsWith("document_share_");
}

function documentShareNotificationRequestId(data) {
  if (!isDocumentShareNotificationType(data)) return null;
  const requestId =
    typeof data?.request_id === "string" ? data.request_id.trim() : "";
  return DOCUMENT_REQUEST_UUID.test(requestId) ? requestId.toLowerCase() : null;
}

function sanitizeDocumentShareNotificationData(data) {
  // Unknown document-share events must remain unacknowledged downstream, but
  // they still cannot carry private content into a log, notification, or click
  // target while the client waits for an explicitly reviewed vocabulary.
  if (!isDocumentShareNotificationCandidate(data)) return null;
  const safe = { type: normalizedDocumentShareType(data) };
  if (!isDocumentShareNotificationType(data)) return safe;
  const requestId = documentShareNotificationRequestId(data);
  if (requestId) safe.request_id = requestId;
  const userId = typeof data?.user_id === "string" ? data.user_id.trim() : "";
  if (userId && userId.length <= 128) safe.user_id = userId;
  return safe;
}

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

function notificationTapTarget(data) {
  const documentRequestId = documentShareNotificationRequestId(data);
  if (documentRequestId) {
    return `/one/consent?tab=pending&requestId=${encodeURIComponent(
      `document_share_request:${documentRequestId}`,
    )}`;
  }
  const type = String(data?.type || "")
    .trim()
    .toLowerCase();
  // Recipient-only alerts match the native/shared FCM tap handler. Historical
  // identifiers must not reopen another workflow or imply current access.
  if (
    type === "location_share_created" ||
    type === "location_access_approved"
  ) {
    return "/one/location?section=shared";
  }
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
    const rawData =
      data.data && typeof data.data === "object" && !Array.isArray(data.data)
        ? data.data
        : {};
    const safeDocumentData = sanitizeDocumentShareNotificationData(rawData);
    const notificationData = safeDocumentData || rawData;
    const title = safeDocumentData
      ? DOCUMENT_SHARE_NOTIFICATION_COPY.title
      : data.notification?.title || data.title || "Notification";
    const body = safeDocumentData
      ? DOCUMENT_SHARE_NOTIFICATION_COPY.body
      : data.notification?.body || data.body || "You have a new notification";
    const url = notificationTapTarget(notificationData);
    const sourceUrl = safeDocumentData
      ? url
      : rawData?.request_url ||
        rawData?.deep_link ||
        rawData?.url ||
        data.fcmOptions?.link ||
        data.webpush?.fcmOptions?.link ||
        data.url ||
        self.__HUSHH_FCM_DEFAULT_TARGET__;
    const notificationIdentity =
      notificationData?.message_id ||
      notificationData?.request_id ||
      notificationData?.bundle_id ||
      notificationData?.grant_id ||
      notificationData?.submission_id ||
      notificationData?.referral_id ||
      notificationData?.connection_id ||
      notificationData?.invite_id ||
      notificationData?.transfer_id ||
      nextDeliveryId();
    const notificationType = String(notificationData?.type || "notification")
      .trim()
      .toLowerCase();
    const tag = safeDocumentData
      ? `hussh:${notificationType}:${notificationIdentity}`
      : notificationData?.notification_tag ||
        data.notification?.tag ||
        `hussh:${notificationType}:${notificationIdentity}`;
    // A sharing review is routine—not an SOS escalation. Its presentation is
    // always the normal system cue regardless of an untrusted provider body.
    const requireInteraction = safeDocumentData
      ? false
      : data.notification?.requireInteraction ?? true;
    const isEmergencySms = isEmergencySmsAlert(notificationData);
    const isSilent = isSilentNotification(notificationData);
    const notificationOptions = {
      body,
      data: {
        ...notificationData,
        source_url: safeDocumentData ? url : sourceUrl,
        url,
      },
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
            data: notificationData,
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
          data: notificationData,
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
  const url = notificationTapTarget(data);
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
