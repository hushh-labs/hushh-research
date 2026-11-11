/** Coordinate-free, account-scoped receipt state. Share expiry is not an ack. */
// Like Location's opened/unwatched markers and sender incident, these browser
// receipts contain opaque grant IDs and state only: no message, position or key.
// They must survive reloads and notify other tabs without requiring vault unlock.
export const SMS_ALARM_ACKNOWLEDGED_EVENT = "hushh:sms-alarm-acknowledged";
export const SMS_ALERTS_CHANGED_EVENT = "hushh:sms-alerts-changed";

export function dispatchSmsAlertsChanged(userId: string): void {
  window.dispatchEvent(new CustomEvent(SMS_ALERTS_CHANGED_EVENT, { detail: { userId } }));
}
const prefix = (userId: string) => `one_location_sms_alarm_v1:${encodeURIComponent(userId)}:`;
const key = (userId: string, grantId: string) => `${prefix(userId)}${encodeURIComponent(grantId)}`;
const syncPrefix = (userId: string) => `${prefix(userId)}sync:`;
const unconfirmed = new Set<string>();
const memory = new Map<string, string>();
const failedWrites = new Set<string>();
const silenceKey = (userId: string, grantId: string) => `${key(userId, grantId)}:silenced`;

export function isSmsAlarmSilenced(userId: string, grantId: string): boolean {
  const storageKey = silenceKey(userId, grantId);
  try { return memory.has(storageKey) || window.localStorage.getItem(storageKey) === "1"; }
  catch { return memory.has(storageKey); }
}

export function silenceSmsAlarm(userId: string, grantId: string): void {
  const storageKey = silenceKey(userId, grantId);
  memory.set(storageKey, "1");
  try { window.localStorage.setItem(storageKey, "1"); } catch { /* Retain the session receipt. */ }
}
// One record per grant avoids losing another tab's alert in a list overwrite.
function write(userId: string, grantId: string, state: "pending" | "acknowledged") {
  // Acknowledgement is a separate monotonic tombstone. A racing tab may
  // rewrite pending, but can never overwrite the recipient's acknowledgement.
  const storageKey = `${key(userId, grantId)}${state === "acknowledged" ? ":ack" : ""}`;
  memory.set(storageKey, state);
  try { window.localStorage.setItem(storageKey, state); failedWrites.delete(storageKey); }
  catch { failedWrites.add(storageKey); }
}

export function pendingSmsAlarms(userId: string): string[] {
  const namespace = prefix(userId);
  try {
    const stored = Array.from({ length: window.localStorage.length }, (_, i) => window.localStorage.key(i))
      .filter((storageKey): storageKey is string => !!storageKey?.startsWith(namespace) && window.localStorage.getItem(storageKey) === "pending")
      .map((storageKey) => decodeURIComponent(storageKey.slice(namespace.length)));
    const unsaved = [...failedWrites].filter((storageKey) => storageKey.startsWith(namespace) && memory.get(storageKey) === "pending")
      .map((storageKey) => decodeURIComponent(storageKey.slice(namespace.length)));
    return [...new Set([...stored, ...unsaved])].filter((grantId) => !isSmsAlarmAcknowledged(userId, grantId));
  } catch {
    return [...memory].filter(([storageKey, state]) => storageKey.startsWith(namespace) && state === "pending")
      .map(([storageKey]) => decodeURIComponent(storageKey.slice(namespace.length)))
      .filter((grantId) => !isSmsAlarmAcknowledged(userId, grantId));
  }
}

export function isSmsAlarmAcknowledged(userId: string, grantId: string): boolean {
  const storageKey = `${key(userId, grantId)}:ack`;
  if (failedWrites.has(storageKey) && memory.get(storageKey) === "acknowledged") return true;
  try { return window.localStorage.getItem(storageKey) === "acknowledged"; }
  catch { return memory.get(storageKey) === "acknowledged"; }
}

export function rememberSmsAlarm(userId: string, grantId: string): void {
  if (!userId || !grantId || isSmsAlarmAcknowledged(userId, grantId)) return;
  write(userId, grantId, "pending");
}

export function acknowledgeSmsAlarm(userId: string, grantId: string, sync = true): void {
  if (!userId || !grantId) return;
  if (sync && !isSmsAlarmAcknowledged(userId, grantId)) {
    const storageKey = `${syncPrefix(userId)}${encodeURIComponent(grantId)}`;
    unconfirmed.add(storageKey);
    try { window.localStorage.setItem(storageKey, "1"); } catch { /* Retry from memory. */ }
  }
  write(userId, grantId, "acknowledged");
  window.dispatchEvent(new CustomEvent(SMS_ALARM_ACKNOWLEDGED_EVENT, { detail: { userId, grantId } }));
}

export function unconfirmedSmsAcknowledgements(userId: string): string[] {
  const namespace = syncPrefix(userId);
  const keys = new Set(unconfirmed);
  try {
    for (let index = 0; index < window.localStorage.length; index++) {
      const storageKey = window.localStorage.key(index);
      if (storageKey?.startsWith(namespace)) keys.add(storageKey);
    }
  } catch { /* Storage may be blocked. */ }
  return [...keys].filter((storageKey) => storageKey.startsWith(namespace))
    .map((storageKey) => decodeURIComponent(storageKey.slice(namespace.length)));
}

export function confirmSmsAcknowledgement(userId: string, grantId: string): void {
  const storageKey = `${syncPrefix(userId)}${encodeURIComponent(grantId)}`;
  unconfirmed.delete(storageKey);
  try { window.localStorage.removeItem(storageKey); } catch { /* The request is idempotent. */ }
}

/** Confirmed account deletion only; sign-out retains unacknowledged receipts. */
export function forgetSmsAlarms(userId: string): void {
  const namespace = prefix(userId);
  for (const storageKey of unconfirmed) if (storageKey.startsWith(namespace)) unconfirmed.delete(storageKey);
  for (const storageKey of memory.keys()) if (storageKey.startsWith(namespace)) {
    memory.delete(storageKey); failedWrites.delete(storageKey);
  }
  for (let index = window.localStorage.length - 1; index >= 0; index--) {
    const storageKey = window.localStorage.key(index);
    if (storageKey?.startsWith(namespace)) window.localStorage.removeItem(storageKey);
  }
}
