"use client";

import { AppBackgroundTaskService } from "@/lib/services/app-background-task-service";

export const ONE_LOCATION_GRANT_OPENED_EVENT = "hushh:one-location-grant-opened";
export const ONE_LOCATION_NOTIFICATION_OPEN_PARAM = "locationNotification";
export const ONE_LOCATION_NOTIFICATION_OPEN_VALUE = "opened";
export const ONE_LOCATION_GRANT_ID_PARAM = "grantId";
export const ONE_LOCATION_REQUEST_ID_PARAM = "requestId";
export const ONE_LOCATION_REFERRAL_ID_PARAM = "referralId";

const OPENED_GRANTS_KEY_PREFIX = "one_location_opened_grants_v1";
const LOCATION_SHARE_TASK_KIND = "one_location_share";
const LOCATION_WORKFLOW_TASK_KIND = "one_location_workflow";

export type OneLocationWorkflowNotificationType =
  | "location_share_created"
  | "location_access_approved"
  | "location_share_revoked"
  | "location_share_expired"
  | "location_access_request"
  | "location_access_denied"
  | "location_referral_invite"
  | "location_public_invite_submitted";

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
  return `/one/location?${params.toString()}`;
}

export function buildOneLocationWorkflowHref(params: {
  grantId?: string | null;
  requestId?: string | null;
  referralId?: string | null;
  openGrant?: boolean;
}): string {
  const query = new URLSearchParams();
  const grantId = String(params.grantId || "").trim();
  const requestId = String(params.requestId || "").trim();
  const referralId = String(params.referralId || "").trim();
  if (grantId) query.set(ONE_LOCATION_GRANT_ID_PARAM, grantId);
  if (requestId) query.set(ONE_LOCATION_REQUEST_ID_PARAM, requestId);
  if (referralId) query.set(ONE_LOCATION_REFERRAL_ID_PARAM, referralId);
  if (grantId && params.openGrant) {
    query.set(ONE_LOCATION_NOTIFICATION_OPEN_PARAM, ONE_LOCATION_NOTIFICATION_OPEN_VALUE);
  }
  const suffix = query.toString();
  return suffix ? `/one/location?${suffix}` : "/one/location";
}

export function locationShareNotificationDescription(ownerLabel?: string | null): string {
  const label = String(ownerLabel || "").trim() || "A trusted person";
  return `${label} shared location access with you. Open this notification to view it.`;
}

export function locationWorkflowNotificationCopy(params: {
  type: OneLocationWorkflowNotificationType;
  ownerLabel?: string | null;
  requesterLabel?: string | null;
  referringLabel?: string | null;
  visitorLabel?: string | null;
}): { title: string; description: string } {
  const copy = WORKFLOW_COPY[params.type];
  const ownerLabel = String(params.ownerLabel || "").trim() || "A trusted person";
  const requesterLabel = String(params.requesterLabel || "").trim() || "Someone";
  const referringLabel = String(params.referringLabel || "").trim() || "A trusted person";
  const visitorLabel = String(params.visitorLabel || "").trim() || "Someone";

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
    default:
      return { title: copy.title, description: copy.fallbackDescription };
  }
}

export function recordOneLocationShareNotification(params: {
  userId: string;
  grantId: string;
  ownerLabel?: string | null;
  expiresAt?: string | null;
  durationHours?: string | number | null;
}): boolean {
  const userId = String(params.userId || "").trim();
  const grantId = String(params.grantId || "").trim();
  if (!userId || !grantId || isOneLocationGrantOpened(userId, grantId)) return false;

  const taskId = oneLocationGrantTaskId(grantId);
  const existing = AppBackgroundTaskService.getTask(taskId);
  if (existing && !existing.dismissedAt) return false;

  const ownerLabel = String(params.ownerLabel || "").trim() || "A trusted person";
  const description = locationShareNotificationDescription(ownerLabel);
  AppBackgroundTaskService.startTask({
    taskId,
    userId,
    kind: LOCATION_SHARE_TASK_KIND,
    title: "Location shared",
    description,
    routeHref: buildOneLocationNotificationHref(grantId),
    visibility: "primary",
    groupLabel: "One Location",
    autoClearAfterMs: 0,
    metadata: {
      grantId,
      ownerLabel,
      expiresAt: params.expiresAt || null,
      durationHours: params.durationHours || null,
    },
  });
  AppBackgroundTaskService.completeTask(taskId, description);
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

  const taskId = oneLocationWorkflowTaskId(params.notificationType, id);
  const existing = AppBackgroundTaskService.getTask(taskId);
  if (existing && !existing.dismissedAt) return false;

  AppBackgroundTaskService.startTask({
    taskId,
    userId,
    kind: LOCATION_WORKFLOW_TASK_KIND,
    title: params.title,
    description: params.description,
    routeHref: params.routeHref || "/one/location",
    visibility: "primary",
    groupLabel: "One Location",
    autoClearAfterMs: 0,
    metadata: {
      notificationType: params.notificationType,
      id,
      ...(params.metadata || {}),
    },
  });
  AppBackgroundTaskService.completeTask(taskId, params.description);
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
