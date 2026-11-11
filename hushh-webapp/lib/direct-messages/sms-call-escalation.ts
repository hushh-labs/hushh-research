"use client";

import { appInteractionCoordinator } from "@/lib/interaction/interaction-intent-coordinator";

export type SmsCallReservation = { callId: string; delayMs: number };
export type SmsCallIntent = { callId: string; incidentId: string };
type SmsCallHost = {
  ownerId: string;
  deviceId: string;
  start: (intent: SmsCallIntent) => void;
  unavailable: () => void;
};

let host: SmsCallHost | null = null;
const listeners = new Set<() => void>();
const pendingCalls = new Map<string, ReturnType<typeof setTimeout>>();
const preferenceKey = (ownerId: string) => `one_location_sms_alarm_v1:${encodeURIComponent(ownerId)}:call-contact`;

export function subscribeSmsCalling(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function smsCallingAvailable(ownerId: string): boolean {
  return host?.ownerId === ownerId;
}

export function registerSmsCallHost(next: SmsCallHost) {
  host = next;
  listeners.forEach((listener) => listener());
  return () => {
    if (host !== next) return;
    host = null;
    for (const timer of pendingCalls.values()) clearTimeout(timer);
    pendingCalls.clear();
    listeners.forEach((listener) => listener());
  };
}

export function getSmsCallContact(ownerId: string): string {
  try { return localStorage.getItem(preferenceKey(ownerId)) ?? ""; }
  catch { return ""; }
}

export function setSmsCallContact(ownerId: string, contactId: string): void {
  if (contactId) localStorage.setItem(preferenceKey(ownerId), contactId);
  else localStorage.removeItem(preferenceKey(ownerId));
  listeners.forEach((listener) => listener());
}

export function smsCallSelection(ownerId: string) {
  const callRecipientUserId = getSmsCallContact(ownerId);
  return host?.ownerId === ownerId && callRecipientUserId
    ? { callDeviceId: host.deviceId, callRecipientUserId }
    : undefined;
}

export function suppressScheduledSmsCall(ownerId: string): void {
  if (host?.ownerId !== ownerId) return;
  for (const timer of pendingCalls.values()) clearTimeout(timer);
}

export async function smsMicrophoneReady(): Promise<boolean> {
  if (document.visibilityState !== "visible" ||
      appInteractionCoordinator.getLifecycleSnapshot().state !== "active") return false;
  try { return (await navigator.permissions.query({ name: "microphone" as PermissionName })).state === "granted"; }
  catch { return false; }
}

export function scheduleSmsCall(ownerId: string, incidentId: string, contactId: string, reservation: SmsCallReservation | null) {
  const caller = host;
  if (!caller || caller.ownerId !== ownerId) return;
  if (!reservation) { caller.unavailable(); return; }
  if (pendingCalls.has(reservation.callId)) return;
  const timer = setTimeout(() => {
    if (host !== caller || getSmsCallContact(ownerId) !== contactId) return;
    if (document.visibilityState !== "visible" || !navigator.onLine ||
        appInteractionCoordinator.getLifecycleSnapshot().state !== "active") {
      caller.unavailable();
      return;
    }
    caller.start({ callId: reservation.callId, incidentId });
  }, Math.max(0, Math.min(10_000, reservation.delayMs)));
  pendingCalls.set(reservation.callId, timer);
}
