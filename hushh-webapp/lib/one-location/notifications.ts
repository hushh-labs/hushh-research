"use client";

import { AppBackgroundTaskService } from "@/lib/services/app-background-task-service";
import { CONSENT_STATE_CHANGED_EVENT } from "@/lib/consent/consent-events";

export const ONE_LOCATION_GRANT_OPENED_EVENT = "hushh:one-location-grant-opened";
export const ONE_LOCATION_NOTIFICATION_OPEN_PARAM = "locationNotification";
export const ONE_LOCATION_NOTIFICATION_OPEN_VALUE = "opened";
export const ONE_LOCATION_GRANT_ID_PARAM = "grantId";
export const ONE_LOCATION_REQUEST_ID_PARAM = "requestId";
export const ONE_LOCATION_REFERRAL_ID_PARAM = "referralId";
export const ONE_LOCATION_SUBMISSION_ID_PARAM = "submissionId";
export const ONE_LOCATION_SECTION_PARAM = "section";

const OPENED_GRANTS_KEY_PREFIX = "one_location_opened_grants_v1";
// Persistent (localStorage) record of every One-Location notification event we
// have ALREADY surfaced for this user, keyed by a stable event identity. This is
// the single source of truth for de-duplication so a notification is created at
// most once per real event - even across page refreshes, tab switches, and
// fresh app sessions. (The background-task store persists to sessionStorage and
// therefore forgets dismissed notifications on reload, which is what caused the
// duplicate / "reappearing after refresh" spam.)
const SEEN_NOTIFICATIONS_KEY_PREFIX = "one_location_seen_notifications_v1";
// Persistent (localStorage) set of received grant ids the recipient has chosen
// to stop watching ("Unwatch"). Stored per-user so it survives refreshes.
const UNWATCHED_GRANTS_KEY_PREFIX = "one_location_unwatched_grants_v1";
const LOCATION_SHARE_TASK_KIND = "one_location_share";
const LOCATION_WORKFLOW_TASK_KIND = "one_location_workflow";

export const ONE_LOCATION_GRANT_UNWATCHED_EVENT =
  "hushh:one-location-grant-unwatched";

export type OneLocationWorkflowNotificationType =
  | "location_share_created"
  | "location_access_approved"
  | "location_share_revoked"
  | "location_share_expired"
  | "location_access_request"
  | "location_access_denied"
  | "location_referral_invite"
  | "location_public_invite_submitted"
  | "location_one_network_joined";

export type OneLocationNotificationSection =
  | "people"
  | "approvals"
  | "shared"
  | "my_requests"
  | "public_responses"
  | "activity";

const WORKFLOW_COPY: Record<
  OneLocationWorkflowNotificationType,
  { title: string; fallbackDescription: string }
> = {
  location_share_created: {
    title: "Location shared",
    fallbackDescription: "A trusted person shared location access with you.",
  },
  location_access_approved: {
    title: "Location request approved",
    fallbackDescription: "Your location request was approved.",
  },
  location_share_revoked: {
    title: "Location access removed",
    fallbackDescription: "Location access from a trusted person was removed.",
  },
  location_share_expired: {
    title: "Location access expired",
    fallbackDescription: "A location share reached its expiry time.",
  },
  location_access_request: {
    title: "Location request",
    fallbackDescription: "Someone is asking to view your location.",
  },
  location_access_denied: {
    title: "Location request denied",
    fallbackDescription: "Your location request was denied.",
  },
  location_referral_invite: {
    title: "Location referral pending",
    fallbackDescription: "A trusted person referred you into a location request flow.",
  },
  location_public_invite_submitted: {
    title: "Public location request",
    fallbackDescription: "Someone requested location access from your public link.",
  },
  location_one_network_joined: {
    title: "Connected on One",
    fallbackDescription: "A trusted person joined your One Network.",
  },
};

function openedGrantStorageKey(userId: string): string {
  return `${OPENED_GRANTS_KEY_PREFIX}:${userId}`;
}

function safeLocalStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function readOpenedGrantIds(userId: string): string[] {
  const normalizedUserId = String(userId || "").trim();
  if (!normalizedUserId) return [];
  const storage = safeLocalStorage();
  if (!storage) return [];
  try {
    const raw = storage.getItem(openedGrantStorageKey(normalizedUserId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.map((item) => String(item || "").trim()).filter(Boolean)
      : [];
  } catch {
    return [];
  }
}

function writeOpenedGrantIds(userId: string, grantIds: string[]): void {
  const normalizedUserId = String(userId || "").trim();
  if (!normalizedUserId) return;
  const storage = safeLocalStorage();
  if (!storage) return;
  try {
    storage.setItem(
      openedGrantStorageKey(normalizedUserId),
      JSON.stringify(Array.from(new Set(grantIds)).filter(Boolean)),
    );
  } catch {
    // Ignore storage write failures; the backend still enforces access.
  }
}

export function isOneLocationGrantOpened(userId: string | null | undefined, grantId: string): boolean {
  const normalizedGrantId = String(grantId || "").trim();
  if (!userId || !normalizedGrantId) return false;
  return readOpenedGrantIds(userId).includes(normalizedGrantId);
}

export function markOneLocationGrantOpened(userId: string | null | undefined, grantId: string): void {
  const normalizedUserId = String(userId || "").trim();
  const normalizedGrantId = String(grantId || "").trim();
  if (!normalizedUserId || !normalizedGrantId) return;
  const opened = readOpenedGrantIds(normalizedUserId);
  if (!opened.includes(normalizedGrantId)) {
    writeOpenedGrantIds(normalizedUserId, [...opened, normalizedGrantId]);
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent(ONE_LOCATION_GRANT_OPENED_EVENT, {
        detail: { userId: normalizedUserId, grantId: normalizedGrantId },
      }),
    );
  }
}

// ---------------------------------------------------------------------------
// Persistent notification de-duplication ("seen" set)
// ---------------------------------------------------------------------------
// Every surfaced notification is keyed by a stable identity string so the same
// real-world event never produces a second toast/bell entry. We persist this to
// localStorage (survives refresh + new sessions), unlike the background-task
// store which lives in sessionStorage.

function seenNotificationsStorageKey(userId: string): string {
  return `${SEEN_NOTIFICATIONS_KEY_PREFIX}:${userId}`;
}

function readSeenNotificationIds(userId: string): Set<string> {
  const normalizedUserId = String(userId || "").trim();
  if (!normalizedUserId) return new Set();
  const storage = safeLocalStorage();
  if (!storage) return new Set();
  try {
    const raw = storage.getItem(seenNotificationsStorageKey(normalizedUserId));
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? new Set(
          parsed.map((item) => String(item || "").trim()).filter(Boolean),
        )
      : new Set();
  } catch {
    return new Set();
  }
}

function writeSeenNotificationIds(userId: string, ids: Set<string>): void {
  const normalizedUserId = String(userId || "").trim();
  if (!normalizedUserId) return;
  const storage = safeLocalStorage();
  if (!storage) return;
  try {
    // Cap the stored history so it can never grow unbounded.
    const MAX_SEEN = 500;
    const all = Array.from(ids).filter(Boolean);
    const trimmed = all.length > MAX_SEEN ? all.slice(all.length - MAX_SEEN) : all;
    storage.setItem(
      seenNotificationsStorageKey(normalizedUserId),
      JSON.stringify(trimmed),
    );
  } catch {
    // Ignore storage write failures; backend still enforces access.
  }
}

/** True if this exact notification event was already surfaced for the user. */
export function hasSeenOneLocationNotification(
  userId: string | null | undefined,
  eventId: string,
): boolean {
  const normalizedEventId = String(eventId || "").trim();
  if (!userId || !normalizedEventId) return false;
  return readSeenNotificationIds(userId).has(normalizedEventId);
}

/** Mark a notification event as surfaced. Returns false if it was already seen. */
export function markOneLocationNotificationSeen(
  userId: string | null | undefined,
  eventId: string,
): boolean {
  const normalizedUserId = String(userId || "").trim();
  const normalizedEventId = String(eventId || "").trim();
  if (!normalizedUserId || !normalizedEventId) return false;
  const seen = readSeenNotificationIds(normalizedUserId);
  if (seen.has(normalizedEventId)) return false;
  seen.add(normalizedEventId);
  writeSeenNotificationIds(normalizedUserId, seen);
  return true;
}

// ---------------------------------------------------------------------------
// Recipient-side "Unwatch" (local hide of a received share)
// ---------------------------------------------------------------------------
// A recipient cannot revoke an owner's grant server-side, but they can choose to
// stop watching it. We persist the hidden grant ids per-user so the choice
// survives refresh. The backend continues to enforce real access.

function unwatchedGrantsStorageKey(userId: string): string {
  return `${UNWATCHED_GRANTS_KEY_PREFIX}:${userId}`;
}

export function readUnwatchedGrantIds(
  userId: string | null | undefined,
): string[] {
  const normalizedUserId = String(userId || "").trim();
  if (!normalizedUserId) return [];
  const storage = safeLocalStorage();
  if (!storage) return [];
  try {
    const raw = storage.getItem(unwatchedGrantsStorageKey(normalizedUserId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.map((item) => String(item || "").trim()).filter(Boolean)
      : [];
  } catch {
    return [];
  }
}

export function isOneLocationGrantUnwatched(
  userId: string | null | undefined,
  grantId: string,
): boolean {
  const normalizedGrantId = String(grantId || "").trim();
  if (!userId || !normalizedGrantId) return false;
  return readUnwatchedGrantIds(userId).includes(normalizedGrantId);
}

export function markOneLocationGrantUnwatched(
  userId: string | null | undefined,
  grantId: string,
): void {
  const normalizedUserId = String(userId || "").trim();
  const normalizedGrantId = String(grantId || "").trim();
  if (!normalizedUserId || !normalizedGrantId) return;
  const current = readUnwatchedGrantIds(normalizedUserId);
  if (!current.includes(normalizedGrantId)) {
    const storage = safeLocalStorage();
    if (storage) {
      try {
        storage.setItem(
          unwatchedGrantsStorageKey(normalizedUserId),
          JSON.stringify([...current, normalizedGrantId]),
        );
      } catch {
        // Ignore storage write failures.
      }
    }
  }
  // Also dismiss any pending notification for this grant so it does not linger.
  dismissOneLocationShareNotification(normalizedGrantId);
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent(ONE_LOCATION_GRANT_UNWATCHED_EVENT, {
        detail: { userId: normalizedUserId, grantId: normalizedGrantId },
      }),
    );
  }
}

export function oneLocationGrantTaskId(grantId: string): string {
  return `${LOCATION_SHARE_TASK_KIND}:${String(grantId || "").trim()}`;
}

export function dismissOneLocationShareNotification(grantId: string): void {
  const normalizedGrantId = String(grantId || "").trim();
  if (!normalizedGrantId) return;
  AppBackgroundTaskService.dismissTask(oneLocationGrantTaskId(normalizedGrantId));
}

export function oneLocationWorkflowTaskId(
  notificationType: OneLocationWorkflowNotificationType,
  id: string,
): string {
  return `${LOCATION_WORKFLOW_TASK_KIND}:${notificationType}:${String(id || "").trim()}`;
}

export function buildOneLocationNotificationHref(grantId: string): string {
  const params = new URLSearchParams();
  params.set(ONE_LOCATION_GRANT_ID_PARAM, grantId);
  params.set(ONE_LOCATION_NOTIFICATION_OPEN_PARAM, ONE_LOCATION_NOTIFICATION_OPEN_VALUE);
  params.set(ONE_LOCATION_SECTION_PARAM, "shared");
  return `/one/location?${params.toString()}`;
}

function normalizeOneLocationHref(value: unknown): string | null {
  const href = typeof value === "string" ? value.trim() : "";
  if (!href || /[\r\n]/.test(href)) return null;

  try {
    const parsed = href.startsWith("/")
      ? new URL(href, "https://hushh.local")
      : new URL(href);
    if (
      parsed.pathname !== "/one/location" &&
      !parsed.pathname.startsWith("/one/location/")
    ) {
      return null;
    }
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return null;
  }
}

export function resolveOneLocationNotificationHref(
  data: Record<string, unknown> | null | undefined,
): string {
  return (
    normalizeOneLocationHref(data?.request_url) ||
    normalizeOneLocationHref(data?.deep_link) ||
    "/one/location"
  );
}

export function buildOneLocationWorkflowHref(params: {
  grantId?: string | null;
  requestId?: string | null;
  referralId?: string | null;
  submissionId?: string | null;
  section?: OneLocationNotificationSection | null;
  openGrant?: boolean;
}): string {
  const query = new URLSearchParams();
  const grantId = String(params.grantId || "").trim();
  const requestId = String(params.requestId || "").trim();
  const referralId = String(params.referralId || "").trim();
  const submissionId = String(params.submissionId || "").trim();
  const section = String(params.section || "").trim();
  if (grantId) query.set(ONE_LOCATION_GRANT_ID_PARAM, grantId);
  if (requestId) query.set(ONE_LOCATION_REQUEST_ID_PARAM, requestId);
  if (referralId) query.set(ONE_LOCATION_REFERRAL_ID_PARAM, referralId);
  if (submissionId) query.set(ONE_LOCATION_SUBMISSION_ID_PARAM, submissionId);
  if (section) query.set(ONE_LOCATION_SECTION_PARAM, section);
  if (grantId && params.openGrant) {
    query.set(ONE_LOCATION_NOTIFICATION_OPEN_PARAM, ONE_LOCATION_NOTIFICATION_OPEN_VALUE);
  }
  const suffix = query.toString();
  return suffix ? `/one/location?${suffix}` : "/one/location";
}

export function oneLocationSectionForWorkflowNotificationType(
  type: OneLocationWorkflowNotificationType,
): OneLocationNotificationSection {
  switch (type) {
    case "location_share_created":
    case "location_access_approved":
    case "location_share_revoked":
    case "location_share_expired":
      return "shared";
    case "location_access_request":
      return "approvals";
    case "location_access_denied":
      return "my_requests";
    case "location_public_invite_submitted":
      return "public_responses";
    case "location_referral_invite":
      return "my_requests";
    case "location_one_network_joined":
      return "people";
    default:
      return "activity";
  }
}

const MASKED_PHONE_ONLY_PATTERN = /^\*{3,}\d{1,4}$/;
const MASKED_PHONE_SUFFIX_PATTERN = /\s+-\s+\*{3,}\d{1,4}\s*$/;
const MASKED_PHONE_BODY_PATTERN = /\s+-\s+\*{3,}\d{1,4}(?=\s|[.,!?]|$)/g;

export function privacySafeOneLocationNotificationLabel(
  value?: string | null,
  fallback = "A trusted person",
): string {
  const normalized = String(value || "").trim();
  if (!normalized || MASKED_PHONE_ONLY_PATTERN.test(normalized)) return fallback;
  return normalized.replace(MASKED_PHONE_SUFFIX_PATTERN, "").trim() || fallback;
}

export function privacySafeOneLocationNotificationBody(
  value: string | null | undefined,
  fallback: string,
): string {
  const normalized = String(value || "").trim();
  if (!normalized) return fallback;
  if (MASKED_PHONE_ONLY_PATTERN.test(normalized.split(/\s+/, 1)[0] || "")) {
    return fallback;
  }
  return normalized.replace(MASKED_PHONE_BODY_PATTERN, "").trim() || fallback;
}

export function locationShareNotificationDescription(ownerLabel?: string | null): string {
  const label = privacySafeOneLocationNotificationLabel(ownerLabel);
  return `${label} shared location access with you.`;
}

/** The share intents a recipient notification can represent. */
export type OneLocationShareKind = "sos" | "check_in" | "drive_to" | "share";

export function normalizeOneLocationShareKind(
  value?: string | null,
): OneLocationShareKind {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "sos") return "sos";
  if (normalized === "check_in" || normalized === "checkin") return "check_in";
  if (normalized === "drive_to" || normalized === "drive") return "drive_to";
  return "share";
}

/** Short, human tag per share kind for badges/labels (SOS / Check-In / Share). */
export function oneLocationShareKindLabel(kind?: string | null): string {
  switch (normalizeOneLocationShareKind(kind)) {
    case "sos":
      return "SOS";
    case "check_in":
      return "Check-In";
    case "drive_to":
      return "Drive";
    default:
      return "Share";
  }
}

/**
 * Kind-aware title + description for a received location share so the recipient
 * instantly sees WHAT it is (emergency SOS vs friendly Check-In vs plain share)
 * and WHY. A Check-In note is surfaced verbatim ("<Owner>: <message>"); SOS gets
 * urgent dedicated copy; a plain share keeps the neutral line.
 */
export function locationShareNotificationCopy(params: {
  ownerLabel?: string | null;
  shareKind?: string | null;
  shareMessage?: string | null;
}): { title: string; description: string } {
  const label = privacySafeOneLocationNotificationLabel(params.ownerLabel);
  const message = String(params.shareMessage || "").trim();
  const kind = normalizeOneLocationShareKind(params.shareKind);
  if (kind === "sos") {
    return {
      title: "SOS alert",
      description: `${label} triggered an SOS and is sharing live location with you. Open to view it now.`,
    };
  }
  if (kind === "check_in") {
    return {
      title: "Check-in shared",
      description: message
        ? `${label}: ${message}`
        : `${label} checked in and shared their location with you.`,
    };
  }
  if (kind === "drive_to") {
    return {
      title: "Drive shared",
      description: `${label} started sharing their drive and live ETA with you.`,
    };
  }
  return {
    title: "Location shared",
    description: locationShareNotificationDescription(label),
  };
}


export function locationWorkflowNotificationCopy(params: {
  type: OneLocationWorkflowNotificationType;
  ownerLabel?: string | null;
  requesterLabel?: string | null;
  referringLabel?: string | null;
  visitorLabel?: string | null;
  networkLabel?: string | null;
}): { title: string; description: string } {
  const copy = WORKFLOW_COPY[params.type];
  const ownerLabel = privacySafeOneLocationNotificationLabel(params.ownerLabel);
  const requesterLabel = privacySafeOneLocationNotificationLabel(
    params.requesterLabel,
    "Someone",
  );
  const referringLabel = privacySafeOneLocationNotificationLabel(params.referringLabel);
  const visitorLabel = privacySafeOneLocationNotificationLabel(params.visitorLabel, "Someone");
  const networkLabel = privacySafeOneLocationNotificationLabel(params.networkLabel);

  switch (params.type) {
    case "location_share_created":
    case "location_access_approved":
      return {
        title: copy.title,
        description: locationShareNotificationDescription(ownerLabel),
      };
    case "location_share_revoked":
      return {
        title: copy.title,
        description: `${ownerLabel} removed your location access.`,
      };
    case "location_share_expired":
      return {
        title: copy.title,
        description: `Location sharing with ${ownerLabel} has expired.`,
      };
    case "location_access_request":
      return {
        title: copy.title,
        description: `${requesterLabel} is asking to view your location.`,
      };
    case "location_access_denied":
      return {
        title: copy.title,
        description: `${ownerLabel} denied your location request.`,
      };
    case "location_referral_invite":
      return {
        title: copy.title,
        description: `${referringLabel} referred you into a location request for ${ownerLabel}.`,
      };
    case "location_public_invite_submitted":
      return {
        title: copy.title,
        description: `${visitorLabel} requested location access from your public link.`,
      };
    case "location_one_network_joined":
      return {
        title: copy.title,
        description: `${networkLabel} is now connected with you on One.`,
      };
    default:
      return { title: copy.title, description: copy.fallbackDescription };
  }
}

// ---------------------------------------------------------------------------
// Consent-surface routing
// ---------------------------------------------------------------------------
// One Location is a CONSENT feature, so its lifecycle events (share, access
// request, approve, deny, revoke, expire) must surface in the consent
// notification icon (the shield "Pending consents" dropdown) and the consent
// manager tabs (Requests / Active Access / History) - NOT the general bell
// (DebateTaskCenter / AppBackgroundTaskService). Those consent surfaces read
// from /api/consent/center/*, which now includes One Location rows via the
// backend OneLocationCenterContributor merge. Dispatching this event nudges the
// consent inbox + consent manager to refetch so the new row appears promptly
// instead of waiting for the next poll.
function notifyConsentSurfaceRefresh(
  notificationType: string,
  id: string,
): void {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(
      new CustomEvent(CONSENT_STATE_CHANGED_EVENT, {
        detail: {
          source: "one_location_notification",
          notificationType,
          id,
        },
      }),
    );
  } catch {
    // Best-effort: the consent surfaces also refresh on their own polling.
  }
}

export function recordOneLocationShareNotification(params: {
  userId: string;
  grantId: string;
  ownerLabel?: string | null;
  expiresAt?: string | null;
  durationHours?: string | number | null;
  shareKind?: string | null;
  shareMessage?: string | null;
}): boolean {
  const userId = String(params.userId || "").trim();
  const grantId = String(params.grantId || "").trim();
  if (!userId || !grantId || isOneLocationGrantOpened(userId, grantId)) return false;
  // The recipient explicitly stopped watching this share - never re-notify.
  if (isOneLocationGrantUnwatched(userId, grantId)) return false;

  // Persistent de-dup: a given share event yields at most one notification,
  // ever (survives refresh, tab change, new session via localStorage).
  const eventId = `share:${grantId}`;
  if (hasSeenOneLocationNotification(userId, eventId)) return false;
  markOneLocationNotificationSeen(userId, eventId);

  // Surface in the bell (DebateTaskCenter / AppBackgroundTaskService) with an
  // "Open" deep-link into the recipient's "Shared with me" section, so the
  // share is reachable from the bell - not only the transient toast. The copy is
  // kind-aware so the bell entry reads "SOS alert" / "Check-in shared" (with the
  // note) / "Location shared" instead of one generic line for every share.
  const ownerLabel = String(params.ownerLabel || "").trim() || "A trusted person";
  const shareKind = normalizeOneLocationShareKind(params.shareKind);
  const { title, description } = locationShareNotificationCopy({
    ownerLabel,
    shareKind: params.shareKind,
    shareMessage: params.shareMessage,
  });
  const taskId = oneLocationGrantTaskId(grantId);
  AppBackgroundTaskService.startTask({
    taskId,
    userId,
    kind: LOCATION_SHARE_TASK_KIND,
    title,
    description,
    routeHref: buildOneLocationNotificationHref(grantId),
    visibility: "primary",
    groupLabel: "Onepoint",
    autoClearAfterMs: 0,
    metadata: {
      grantId,
      ownerLabel,
      expiresAt: params.expiresAt || null,
      durationHours: params.durationHours || null,
      shareKind,
      shareMessage: String(params.shareMessage || "").trim() || null,
    },
  });
  AppBackgroundTaskService.completeTask(taskId, description);

  // Also route to the consent surfaces (shield icon + consent manager).
  notifyConsentSurfaceRefresh("location_share_created", grantId);
  return true;
}


export function recordOneLocationWorkflowNotification(params: {
  userId: string;
  notificationType: OneLocationWorkflowNotificationType;
  id: string;
  title: string;
  description: string;
  routeHref?: string | null;
  metadata?: Record<string, unknown> | null;
}): boolean {
  const userId = String(params.userId || "").trim();
  const id = String(params.id || "").trim();
  if (!userId || !id) return false;

  // Persistent de-dup keyed by (type, id): each consent event yields at most one
  // notification, ever. This stops the "same notification again after refresh
  // / tab change" spam (the seen-set lives in localStorage).
  const eventId = `${params.notificationType}:${id}`;
  if (hasSeenOneLocationNotification(userId, eventId)) return false;
  markOneLocationNotificationSeen(userId, eventId);

  // Surface in the bell (DebateTaskCenter / AppBackgroundTaskService) with an
  // "Open" deep-link into the relevant One-Location section, so the workflow
  // event is reachable from the bell - not only the transient toast.
  const taskId = oneLocationWorkflowTaskId(params.notificationType, id);
  AppBackgroundTaskService.startTask({
    taskId,
    userId,
    kind: LOCATION_WORKFLOW_TASK_KIND,
    title: params.title,
    description: params.description,
    routeHref: params.routeHref || "/one/location",
    visibility: "primary",
    groupLabel: "Onepoint",
    autoClearAfterMs: 0,
    metadata: {
      notificationType: params.notificationType,
      id,
      ...(params.metadata || {}),
    },
  });
  AppBackgroundTaskService.completeTask(taskId, params.description);

  // Also route to the consent surfaces (shield icon + consent manager).
  notifyConsentSurfaceRefresh(params.notificationType, id);
  return true;
}


export function playOneLocationNotificationSound(): void {
  if (typeof window === "undefined") return;
  const audioContextConstructor =
    window.AudioContext ||
    (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!audioContextConstructor) return;

  try {
    const context = new audioContextConstructor();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(880, context.currentTime);
    oscillator.frequency.exponentialRampToValueAtTime(660, context.currentTime + 0.12);
    gain.gain.setValueAtTime(0.0001, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.08, context.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.22);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.24);
    oscillator.onended = () => {
      void context.close().catch(() => undefined);
    };
  } catch {
    // Browsers can block audio without user activation; notification UI still works.
  }
}
