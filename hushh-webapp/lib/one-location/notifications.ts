"use client";

import { AppBackgroundTaskService } from "@/lib/services/app-background-task-service";

export const ONE_LOCATION_GRANT_OPENED_EVENT = "hushh:one-location-grant-opened";
export const ONE_LOCATION_NOTIFICATION_OPEN_PARAM = "locationNotification";
export const ONE_LOCATION_NOTIFICATION_OPEN_VALUE = "opened";
export const ONE_LOCATION_GRANT_ID_PARAM = "grantId";

const OPENED_GRANTS_KEY_PREFIX = "one_location_opened_grants_v1";
const LOCATION_SHARE_TASK_KIND = "one_location_share";

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

export function buildOneLocationNotificationHref(grantId: string): string {
  const params = new URLSearchParams();
  params.set(ONE_LOCATION_GRANT_ID_PARAM, grantId);
  params.set(ONE_LOCATION_NOTIFICATION_OPEN_PARAM, ONE_LOCATION_NOTIFICATION_OPEN_VALUE);
  return `/one/location?${params.toString()}`;
}

export function locationShareNotificationDescription(ownerLabel?: string | null): string {
  const label = String(ownerLabel || "").trim() || "A trusted person";
  return `${label} shared location access with you. Open this notification to view it.`;
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
