/**
 * Unified FCM Service
 * ====================
 * 
 * Single FCM implementation that works on BOTH web and native platforms.
 * Replaces the hybrid SSE+FCM approach with FCM-only architecture.
 * 
 * Features:
 * - Platform detection (web vs native)
 * - Token management (get, register, delete)
 * - Message listeners (foreground + background)
 * - Unified event dispatching
 */

import { Capacitor } from "@capacitor/core";
import { ApiService } from "@/lib/services/api-service";
import { ROUTES } from "@/lib/navigation/routes";
import { resolveConsentNavigationTarget } from "@/lib/consent/consent-sheet-route";
import {
  assignWindowLocation,
  requestInternalAppNavigation,
} from "@/lib/utils/browser-navigation";

// Event name for FCM messages (both web and native dispatch this)
export const FCM_MESSAGE_EVENT = "fcm-message";

export type FCMInitStatus =
  | "push_active"
  | "push_blocked"
  | "push_failed"
  | "unsupported";

export interface FCMInitResult {
  status: FCMInitStatus;
  detail?: string;
}

let nativeListenersConfigured = false;
let webListenerConfigured = false;
let lastKnownSession: { userId: string; idToken: string } | null = null;
const FIREBASE_WEB_PUSH_DATABASES = [
  "firebase-messaging-database",
  "firebase-installations-database",
  "fcm_token_details_db",
  "fcm_vapid_details_db",
  "undefined",
] as const;
const FIREBASE_DEFAULT_WEB_PUSH_PUBLIC_KEY =
  "BDOU99-h67HcA6JeFXHbSNMu7e2yNNu3RzoMj8TM4W88jITfq7ZmPvIM1Iv-4_l2LxQcYwhqby2xGpWwzjfAnG4";

function hasValidWebMessagingConfig(app: {
  options?: {
    appId?: string;
    apiKey?: string;
    messagingSenderId?: string;
  };
}): boolean {
  return Boolean(
    app.options?.appId &&
      app.options?.apiKey &&
      app.options?.messagingSenderId
  );
}

function arrayBufferToBase64Url(buffer: ArrayBuffer | null): string {
  if (!buffer) {
    return "";
  }
  const bytes = new Uint8Array(buffer);
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function base64UrlToArrayBuffer(value: string): ArrayBuffer {
  const normalized = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

function generateBrowserFid(): string {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const bytes = new Uint8Array(17);
  window.crypto.getRandomValues(bytes);
  const firstByte = bytes[0] ?? 0;
  bytes[0] = 112 + (firstByte % 16);

  let output = "";
  for (let index = 0; index < bytes.length; index += 1) {
    const nextByte = bytes[index] ?? 0;
    output += alphabet.charAt(nextByte % alphabet.length);
  }
  return output.slice(0, 22);
}

function browserFetch(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  return window.fetch(input, init);
}

function formatManualRegistrationErrorBody(body: unknown): string {
  if (typeof body === "string") {
    return body;
  }
  if (body && typeof body === "object") {
    try {
      return JSON.stringify(body);
    } catch {
      return "[unserializable_error_body]";
    }
  }
  return "unknown";
}

async function ensureBrowserPushSubscription(
  registration: ServiceWorkerRegistration,
  publicKey: string
): Promise<PushSubscription> {
  const existingSubscription = await registration.pushManager.getSubscription();
  if (existingSubscription) {
    return existingSubscription;
  }

  return registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: base64UrlToArrayBuffer(publicKey),
  });
}

type ManualInstallationsAuth = {
  authToken: string;
};

async function createInstallationsAuthToken(app: {
  options?: {
    appId?: string;
    apiKey?: string;
    projectId?: string;
  };
}): Promise<ManualInstallationsAuth> {
  const projectId = app.options?.projectId;
  const appId = app.options?.appId;
  const apiKey = app.options?.apiKey;

  if (!projectId || !appId || !apiKey) {
    throw new Error("missing_installations_app_config");
  }

  const response = await browserFetch(
    `https://firebaseinstallations.googleapis.com/v1/projects/${projectId}/installations`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        fid: generateBrowserFid(),
        appId,
        authVersion: "FIS_v2",
        sdkVersion: "w:0.6.19",
      }),
    }
  );

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload?.authToken?.token) {
    throw new Error(
      `installations_create_failed:${response.status}:${payload?.error?.message ?? "unknown"}`
    );
  }

  return {
    authToken: String(payload.authToken.token),
  };
}

async function registerWebPushTokenManually(
  app: {
    options?: {
      appId?: string;
      apiKey?: string;
      projectId?: string;
      messagingSenderId?: string;
    };
  },
  registration: ServiceWorkerRegistration,
  publicKey: string,
  usesDefaultWebPushKey: boolean
): Promise<string> {
  console.info("[FCM] Starting manual web push registration.", {
    usesDefaultWebPushKey,
    projectId: app.options?.projectId,
    projectNumber: app.options?.messagingSenderId,
  });
  const subscription = await ensureBrowserPushSubscription(registration, publicKey);
  const auth = await createInstallationsAuthToken(app);
  const projectId = app.options?.projectId;
  const projectNumber = app.options?.messagingSenderId;
  const apiKey = app.options?.apiKey;

  if (!projectId || !projectNumber || !apiKey) {
    throw new Error("missing_messaging_registration_config");
  }

  const payload = {
    web: {
      endpoint: subscription.endpoint,
      auth: arrayBufferToBase64Url(subscription.getKey("auth")),
      p256dh: arrayBufferToBase64Url(subscription.getKey("p256dh")),
      ...(usesDefaultWebPushKey
        ? {}
        : { applicationPubKey: publicKey }),
    },
  };

  const registrationTargets = [
    `https://fcmregistrations.googleapis.com/v1/projects/${projectId}/registrations`,
    `https://fcmregistrations.googleapis.com/v1/projects/${projectNumber}/registrations`,
  ];

  let lastError = "unknown_manual_registration_error";
  for (const endpoint of registrationTargets) {
    console.info("[FCM] Manual registration attempt:", {
      endpoint,
      mode: usesDefaultWebPushKey ? "default_web_push_key" : "custom_vapid",
    });
    const response = await browserFetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "x-goog-api-key": apiKey,
        "x-goog-firebase-installations-auth": `FIS ${auth.authToken}`,
      },
      body: JSON.stringify(payload),
    });

    const responseText = await response.text().catch(() => "");
    let body: unknown = responseText;
    try {
      body = responseText ? (JSON.parse(responseText) as unknown) : {};
    } catch {
      body = responseText;
    }
    const manualToken =
      body &&
      typeof body === "object" &&
      "token" in body &&
      typeof (body as { token?: unknown }).token === "string"
        ? String((body as { token: string }).token)
        : null;

    if (response.ok && manualToken) {
      console.log("[FCM] Manual registration succeeded:", endpoint);
      return manualToken;
    }

    const errorMessage =
      body && typeof body === "object" && "error" in body
        ? typeof (body as { error?: { message?: unknown } }).error?.message === "string"
          ? String((body as { error?: { message?: unknown } }).error?.message)
          : formatManualRegistrationErrorBody(
              (body as { error?: unknown }).error ?? body
            )
        : formatManualRegistrationErrorBody(body);

    lastError = `manual_registration_failed:${response.status}:${endpoint}:${errorMessage}`;
    console.warn("[FCM] Manual registration attempt failed:", {
      endpoint,
      status: response.status,
      body,
    });
  }

  throw new Error(lastError);
}

async function clearFirebaseWebPushState(
  registration: ServiceWorkerRegistration
): Promise<void> {
  try {
    const subscription = await registration.pushManager.getSubscription();
    if (subscription) {
      const endpoint = subscription.endpoint;
      await subscription.unsubscribe();
      console.log("[FCM] Cleared stale web push subscription:", endpoint);
    }
  } catch (error) {
    console.warn("[FCM] Failed to clear existing push subscription:", error);
  }

  if (!("indexedDB" in window)) {
    return;
  }

  await Promise.all(
    FIREBASE_WEB_PUSH_DATABASES.map(
      (dbName) =>
        new Promise<void>((resolve) => {
          try {
            const request = window.indexedDB.deleteDatabase(dbName);
            request.onsuccess = () => resolve();
            request.onerror = () => resolve();
            request.onblocked = () => resolve();
          } catch {
            resolve();
          }
        })
    )
  );

  console.log("[FCM] Cleared cached Firebase web push state.");
}

/**
 * Initialize FCM for current platform (web or native)
 * 
 * @param userId - User ID for backend registration
 * @param idToken - Firebase ID token for authentication
 */
export async function initializeFCM(
  userId: string,
  idToken: string
): Promise<FCMInitResult> {
  const isNative = Capacitor.isNativePlatform();
  lastKnownSession = { userId, idToken };

  if (isNative) {
    return initializeNativeFCM(userId, idToken);
  }
  return initializeWebFCM(userId, idToken);
}

/**
 * Initialize FCM for native platforms (iOS/Android)
 */
async function initializeNativeFCM(
  userId: string,
  idToken: string
): Promise<FCMInitResult> {
  try {
    console.log("[FCM] Initializing for native platform...");

    const { FirebaseMessaging } = await import("@capacitor-firebase/messaging");

    // Step 1: Request notification permissions
    const permissionResult = await FirebaseMessaging.requestPermissions();
    console.log("[FCM] Permission result:", permissionResult);

    if (permissionResult.receive !== "granted") {
      console.warn("[FCM] Notification permission not granted");
      return {
        status: "push_blocked",
        detail: `native_permission_${permissionResult.receive}`,
      };
    }

    // Step 2: Get FCM token
    const { token } = await FirebaseMessaging.getToken();
    console.log("[FCM] Got token:", token.substring(0, 20) + "...");

    // Step 3: Register token with backend
    const platform = Capacitor.getPlatform() as "ios" | "android" | "web";
    const response = await ApiService.registerPushToken(
      userId,
      token,
      platform,
      idToken
    );

    if (response.ok) {
      console.log("[FCM] ✅ Token registered with backend");
    } else {
      const detail = await response.text().catch(() => "");
      console.error("[FCM] ❌ Failed to register token:", response.status, detail);
      return {
        status: "push_failed",
        detail: `backend_register_${response.status}`,
      };
    }

    // Step 4: Set up message listeners
    setupNativeListeners();

    console.log("[FCM] ✅ Native initialization complete");
    return { status: "push_active" };
  } catch (error) {
    console.error("[FCM] ❌ Native initialization failed:", error);
    return {
      status: "push_failed",
      detail: error instanceof Error ? error.message : "native_init_failed",
    };
  }
}

/**
 * Initialize FCM for web platform
 */
async function initializeWebFCM(
  userId: string,
  idToken: string
): Promise<FCMInitResult> {
  try {
    console.log("[FCM] Initializing for web platform...");

    // Check for required env var
    const vapidKey = process.env.NEXT_PUBLIC_FIREBASE_VAPID_KEY;
    if (!vapidKey) {
      console.warn("[FCM] NEXT_PUBLIC_FIREBASE_VAPID_KEY not set");
      return { status: "push_failed", detail: "missing_vapid_key" };
    }

    // Request notification permission
    if (!("Notification" in window)) {
      console.warn("[FCM] Notifications not supported");
      return { status: "unsupported", detail: "notification_unsupported" };
    }

    if (Notification.permission === "denied") {
      console.warn("[FCM] Notification permission denied");
      return { status: "push_blocked", detail: "permission_denied" };
    }

    if (Notification.permission !== "granted") {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        console.warn("[FCM] Notification permission not granted");
        return { status: "push_blocked", detail: `permission_${permission}` };
      }
    }

    // Get FCM token
    const { getMessaging, getToken, onMessage } = await import(
      "firebase/messaging"
    );
    const { app } = await import("@/lib/firebase/config");

    // Check for required Firebase config values before initializing messaging
    // The Firebase Web SDK requires appId for the Installations service (used by getToken)
    if (!hasValidWebMessagingConfig(app)) {
      console.warn(
        "[FCM] Missing required Firebase Messaging config (appId/apiKey/messagingSenderId). Skipping web FCM init."
      );
      return {
        status: "push_failed",
        detail: "missing_firebase_messaging_config",
      };
    }

    if (!("serviceWorker" in navigator)) {
      console.warn("[FCM] Service workers not supported for web push");
      return { status: "unsupported", detail: "service_worker_unsupported" };
    }

    const registration = await navigator.serviceWorker.register(
      "/firebase-messaging-sw.js"
    );
    await navigator.serviceWorker.ready;
    console.log(
      "[FCM] Service worker ready:",
      registration.scope
    );

    const messaging = getMessaging(app);
    const resolveWebToken = async (useCustomVapid: boolean) => {
      const options = useCustomVapid
        ? {
            vapidKey,
            serviceWorkerRegistration: registration,
          }
        : {
            serviceWorkerRegistration: registration,
          };
      return getToken(messaging, options);
    };

    let token: string | null = null;
    let usedDefaultVapidFallback = false;
    let recoveredStalePushState = false;

    try {
      token = await resolveWebToken(true);
    } catch (primaryError) {
      const primaryErrorCode =
        typeof primaryError === "object" && primaryError && "code" in primaryError
          ? String((primaryError as { code?: unknown }).code ?? "")
          : "";
      if (primaryErrorCode !== "messaging/token-subscribe-failed") {
        throw primaryError;
      }

      console.warn(
        "[FCM] Custom VAPID subscribe failed. Retrying with the project's default web push configuration.",
        primaryError
      );

      try {
        await clearFirebaseWebPushState(registration);
        recoveredStalePushState = true;

        try {
          token = await resolveWebToken(true);
          console.log(
            "[FCM] Custom VAPID subscribe succeeded after clearing stale browser push state."
          );
        } catch (retryCustomError) {
          console.warn(
            "[FCM] Custom VAPID retry still failed after clearing browser push state. Falling back to the project's default web push configuration.",
            retryCustomError
          );
          await clearFirebaseWebPushState(registration);
          token = await resolveWebToken(false);
          usedDefaultVapidFallback = true;
          console.log(
            "[FCM] Default web push configuration succeeded after clearing stale browser push state."
          );
        }
      } catch (fallbackError) {
        console.warn(
          "[FCM] Default web push configuration also failed. Attempting manual FCM registration against the current project.",
          fallbackError
        );

        try {
          token = await registerWebPushTokenManually(
            app,
            registration,
            vapidKey,
            false
          );
          recoveredStalePushState = true;
          console.log(
            "[FCM] Manual web push registration succeeded after SDK subscribe failures using the configured VAPID key."
          );
        } catch (manualCustomError) {
          console.warn(
            "[FCM] Manual registration with the configured VAPID key failed. Retrying with the project's default web push configuration.",
            manualCustomError
          );
          try {
            token = await registerWebPushTokenManually(
              app,
              registration,
              FIREBASE_DEFAULT_WEB_PUSH_PUBLIC_KEY,
              true
            );
            usedDefaultVapidFallback = true;
            recoveredStalePushState = true;
            console.log(
              "[FCM] Manual web push registration succeeded with the project's default web push configuration."
            );
          } catch (manualDefaultError) {
            const detail =
              manualDefaultError instanceof Error
                ? manualDefaultError.message
                : "manual_registration_failed";
            console.warn(
              "[FCM] Manual web push registration also failed. Check Firebase Console > Project Settings > Cloud Messaging > Web configuration for this project.",
              manualDefaultError
            );
            return {
              status: "push_failed",
              detail,
            };
          }
        }
      }
    }

    if (!token) {
      console.warn("[FCM] Failed to get token");
      return { status: "push_failed", detail: "empty_push_token" };
    }

    console.log("[FCM] Got token:", token.substring(0, 20) + "...");

    // Register token with backend
    const response = await ApiService.registerPushToken(
      userId,
      token,
      "web",
      idToken
    );

    if (response.ok) {
      console.log("[FCM] ✅ Token registered with backend");
    } else {
      const detail = await response.text().catch(() => "");
      console.error("[FCM] ❌ Failed to register token:", response.status, detail);
      return {
        status: "push_failed",
        detail: `backend_register_${response.status}`,
      };
    }

    // Set up foreground message listener
    if (!webListenerConfigured) {
      onMessage(messaging, (payload) => {
        console.log("[FCM] 📬 Foreground message received:", payload);
        window.dispatchEvent(
          new CustomEvent(FCM_MESSAGE_EVENT, {
            detail: payload,
          })
        );
      });
      webListenerConfigured = true;
    }

    console.log("[FCM] ✅ Web initialization complete");
    return {
      status: "push_active",
      detail: usedDefaultVapidFallback
        ? "default_vapid_fallback"
        : recoveredStalePushState
          ? "stale_push_state_recovered"
          : undefined,
    };
  } catch (error) {
    const errorCode =
      typeof error === "object" && error && "code" in error
        ? String((error as { code?: unknown }).code ?? "")
        : "";
    const errorMessage =
      error instanceof Error ? error.message : typeof error === "string" ? error : "";
    if (errorCode === "installations/request-failed") {
      console.warn(
        "[FCM] Web push init skipped: Firebase Installations rejected config. Check Firebase web app keys, API key referrer restrictions, and VAPID key for this domain."
      );
      return {
        status: "push_failed",
        detail: "installations_request_failed",
      };
    }
    if (errorCode === "messaging/token-subscribe-failed") {
      console.warn(
        "[FCM] Web push subscribe failed. Check FCM Registration API, API key restrictions, and VAPID/project alignment.",
        errorMessage
      );
      return {
        status: "push_failed",
        detail: "token_subscribe_failed",
      };
    }
    console.error("[FCM] ❌ Web initialization failed:", error);
    return {
      status: "push_failed",
      detail: errorCode || errorMessage || "web_init_failed",
    };
  }
}

/**
 * Set up message listeners for native platforms
 */
function setupNativeListeners(): void {
  if (nativeListenersConfigured) return;
  nativeListenersConfigured = true;

  void (async () => {
    try {
      const { FirebaseMessaging } = await import("@capacitor-firebase/messaging");

      await FirebaseMessaging.addListener("notificationReceived", (notification) => {
        console.log("[FCM] Foreground message received:", notification);

        window.dispatchEvent(
          new CustomEvent(FCM_MESSAGE_EVENT, {
            detail: notification,
          })
        );
      });

      await FirebaseMessaging.addListener(
        "notificationActionPerformed",
        (action) => {
          console.log("[FCM] Notification tapped:", action);

          const data = action.notification.data as
            | Record<string, unknown>
            | undefined;

          if (
            data &&
            typeof data.type === "string" &&
            data.type === "consent_request"
          ) {
            const target = resolveConsentNavigationTarget(
              (typeof data.request_url === "string" && data.request_url) ||
                (typeof data.deep_link === "string" && data.deep_link) ||
                null,
              "pending"
            );
            if (target.kind === "internal") {
              requestInternalAppNavigation({
                href: target.href,
                scroll: false,
              });
            } else {
              assignWindowLocation(target.href || buildConsentTargetPath(data));
            }
          } else if (
            data &&
            typeof data.type === "string" &&
            data.type === "kai_analysis_complete"
          ) {
            assignWindowLocation(ROUTES.KAI_DASHBOARD);
          } else {
            assignWindowLocation(ROUTES.HOME);
          }
        }
      );

      await FirebaseMessaging.addListener("tokenReceived", async (event) => {
        console.log("[FCM] Token refreshed:", event.token.substring(0, 20) + "...");
        const platform = Capacitor.getPlatform() as "ios" | "android" | "web";
        try {
          if (lastKnownSession) {
            await ApiService.registerPushToken(
              lastKnownSession.userId,
              event.token,
              platform,
              lastKnownSession.idToken
            );
            console.log("[FCM] Refreshed token re-registered with backend");
          }
        } catch (err) {
          console.warn("[FCM] Token refresh re-registration failed:", err);
        }
      });

      console.log("[FCM] Native listeners configured");
    } catch (error) {
      console.warn("[FCM] Native listener setup skipped:", error);
    }
  })();
}

function buildConsentTargetPath(
  data: Record<string, unknown> | undefined
): string {
  const requestId =
    data && typeof data.request_id === "string" ? data.request_id : undefined;
  const bundleId =
    data && typeof data.bundle_id === "string" ? data.bundle_id : undefined;
  return resolveConsentNavigationTarget(null, "pending", {
    requestId,
    bundleId,
  }).href;
}

/**
 * Get current FCM token (for debugging)
 */
export async function getFCMToken(): Promise<string | null> {
  const isNative = Capacitor.isNativePlatform();

  try {
    if (isNative) {
      const { FirebaseMessaging } = await import(
        "@capacitor-firebase/messaging"
      );
      const { token } = await FirebaseMessaging.getToken();
      return token;
    } else {
      const vapidKey = process.env.NEXT_PUBLIC_FIREBASE_VAPID_KEY;
      if (!vapidKey) return null;

      const { getMessaging, getToken } = await import("firebase/messaging");
      const { app } = await import("@/lib/firebase/config");
      if (!hasValidWebMessagingConfig(app)) {
        console.warn("[FCM] Missing Firebase Messaging config. Skipping token retrieval.");
        return null;
      }

      const messaging = getMessaging(app);
      const registration = await navigator.serviceWorker.register(
        "/firebase-messaging-sw.js"
      );
      const token = await getToken(messaging, {
        vapidKey,
        serviceWorkerRegistration: registration,
      });
      return token || null;
    }
  } catch (error) {
    console.error("[FCM] Failed to get token:", error);
    return null;
  }
}

/**
 * Delete FCM token (for logout).
 * 
 * Removes the token from Firebase and also calls the backend to unregister
 * so no further pushes are attempted for this device.
 */
export async function deleteFCMToken(
  userId?: string,
  idToken?: string
): Promise<void> {
  const isNative = Capacitor.isNativePlatform();

  try {
    // Step 1: Tell the backend to delete our push token
    if (userId && idToken) {
      try {
        await ApiService.unregisterPushToken(userId, idToken);
      } catch (backendErr) {
        console.warn("[FCM] Backend unregister failed (non-critical):", backendErr);
      }
    }

    // Step 2: Delete the token from Firebase SDK
    if (isNative) {
      const { FirebaseMessaging } = await import(
        "@capacitor-firebase/messaging"
      );
      await FirebaseMessaging.deleteToken();
    } else {
      const { getMessaging, deleteToken } = await import("firebase/messaging");
      const { app } = await import("@/lib/firebase/config");
      if (!hasValidWebMessagingConfig(app)) {
        console.warn("[FCM] Missing Firebase Messaging config. Skipping token deletion.");
        return;
      }

      const messaging = getMessaging(app);
      await deleteToken(messaging);
    }

    console.log("[FCM] Token deleted (Firebase + backend)");
  } catch (error) {
    console.error("[FCM] Failed to delete token:", error);
  }
}
