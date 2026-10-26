/** Closed notification payload vocabulary and typed navigation for the worker. */
(() => {
  // Keep this closed vocabulary and UUID rule aligned with
  // lib/consent/document-share-consent.ts. A document-share push is only a
  // wake-up signal; raw provider URLs and file/recipient details never leave
  // this worker or choose a navigation target.
  const DOCUMENT_SHARE_NOTIFICATION_TYPES = new Set([
    "document_share_request",
    "document_share_review_ready",
    "document_share_payment_ready",
    "document_share_payment_confirmed",
    "document_share_payment_refunded",
    "document_share_decided",
    "document_share_outcome",
    "document_share_revoked",
    "document_share_revocation_outcome",
    // To the owner: the requester asked about files a partial delivery missed.
    "document_share_review_requested",
    // Drive questions (drive_query_events): their request_id is a question.
    "document_share_question",
    "document_share_answered",
    "document_share_declined",
  ]);
  const DRIVE_QUESTION_NOTIFICATION_TYPES = new Set([
    "document_share_question",
    "document_share_answered",
    "document_share_declined",
  ]);
  const DOCUMENT_REQUEST_UUID =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  // The screen that clears each owner setup step a document_share_request push
  // may name. This worker cannot import TypeScript: keep every value equal to
  // documentRequestSetupHref(step) in lib/consent/document-request-setup.ts.
  const DOCUMENT_REQUEST_SETUP_TARGETS = {
    drive:
      "/one/feed?profile_pane=1&profile_panel=connectors&profile_detail=connector%3Agoogle_drive",
    payouts: "/one/profile/payouts?from=%2Fone%2Ffeed",
    price: "/one/profile/request-pricing?from=%2Fone%2Ffeed",
  };
  const DOCUMENT_SHARE_NOTIFICATION_COPY = {
    title: "Document request",
    body: "Open One for next steps.",
  };
  // Fixed words per reviewed type; keep aligned with
  // lib/consent/document-share-consent.ts and the backend worker.
  const DOCUMENT_SHARE_NOTIFICATION_COPY_BY_TYPE = {
    document_share_request: DOCUMENT_SHARE_NOTIFICATION_COPY,
    document_share_review_ready: {
      title: "Files ready to review",
      body: "Open One to choose what to share.",
    },
    document_share_payment_ready: {
      title: "Payment needed",
      body: "Pay in One to continue your document request.",
    },
    document_share_payment_confirmed: {
      title: "Payment confirmed",
      body: "Open One for your document request update.",
    },
    document_share_payment_refunded: {
      title: "Payment refunded",
      body: "Open One for your document request update.",
    },
    document_share_decided: {
      title: "Drive sharing update",
      body: "Open One to see the latest.",
    },
    document_share_outcome: {
      title: "Drive request update",
      body: "Open One to see the result.",
    },
    document_share_revoked: {
      title: "Drive access changed",
      body: "Open One to see what changed.",
    },
    document_share_revocation_outcome: {
      title: "Drive access changed",
      body: "Open One to see what changed.",
    },
    document_share_review_requested: {
      title: "Review requested",
      body: "Open One to see the files that weren't shared.",
    },
    document_share_question: {
      title: "Drive question",
      body: "Someone asked about your Drive. Open One to review.",
    },
    document_share_answered: {
      title: "Drive question answered",
      body: "Open One to see the answer.",
    },
    document_share_declined: {
      title: "Drive question declined",
      body: "Open One for details.",
    },
  };

  function documentShareNotificationCopy(data) {
    return (
      DOCUMENT_SHARE_NOTIFICATION_COPY_BY_TYPE[
        normalizedDocumentShareType(data)
      ] || DOCUMENT_SHARE_NOTIFICATION_COPY
    );
  }

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

  // Only a closed step on the owner's request push, with an exact request UUID.
  function documentRequestSetupStep(data) {
    if (normalizedDocumentShareType(data) !== "document_share_request") return null;
    if (!documentShareNotificationRequestId(data)) return null;
    const setup = data?.setup;
    return setup === "drive" || setup === "payouts" || setup === "price"
      ? setup
      : null;
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
    const setup = documentRequestSetupStep(data);
    if (setup) safe.setup = setup;
    const userId = typeof data?.user_id === "string" ? data.user_id.trim() : "";
    if (userId && userId.length <= 128) safe.user_id = userId;
    return safe;
  }

  function notificationTapTarget(data) {
    if (data?.type === "todo_reminder") return "/one/todos";
    if (data?.type === "location_circle_message") {
      const circleId = String(data.circle_id || "");
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(circleId)) return "/one/feed";
      return `/one/connect?tab=circles&action=circle-detail&circleId=${encodeURIComponent(circleId)}&circleChat=1`;
    }
    const documentRequestId = documentShareNotificationRequestId(data);
    if (documentRequestId) {
      const eventType = normalizedDocumentShareType(data);
      if (eventType === "document_share_payment_ready" ||
          eventType === "document_share_payment_confirmed" ||
          eventType === "document_share_payment_refunded") return "/one/feed";
      const setup = documentRequestSetupStep(data);
      if (setup) return DOCUMENT_REQUEST_SETUP_TARGETS[setup];
      const selection = DRIVE_QUESTION_NOTIFICATION_TYPES.has(
        normalizedDocumentShareType(data),
      )
        ? `drive_query_request:${documentRequestId}`
        : `document_share_request:${documentRequestId}`;
      return `/one/consent?tab=pending&requestId=${encodeURIComponent(selection)}`;
    }
    const type = String(data?.type || "")
      .trim()
      .toLowerCase();
    // Private-message pushes carry only opaque identifiers. The app verifies
    // conversation membership before it renders any history.
    if (type === "direct_message") {
      const routeToken = String(data?.route_token || "");
      if (routeToken.startsWith("dm1.")) return `/one/messages?token=${encodeURIComponent(routeToken)}`;
      return "/one/messages";
    }
    // Recipient-only alerts match the native/shared FCM tap handler. Historical
    // identifiers must not reopen another workflow or imply current access.
    if (
      type === "location_share_created" ||
      type === "location_access_approved"
    ) {
      return "/one/location?section=shared";
    }
    // The requester's answer opens the chat that asked, found after unlock.
    if (type === "information_request_updated") {
      const bundleId = String(data?.bundle_id || "").trim();
      return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(bundleId)
        ? `/?informationRequest=${encodeURIComponent(bundleId)}`
        : "/";
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

  self.HushhNotificationPayloads = { documentShareNotificationCopy, sanitizeDocumentShareNotificationData, notificationTapTarget };
})();
