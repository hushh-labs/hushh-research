/** Coordinate-free, account-scoped receipt state. Share expiry is not an ack. */
export const SMS_ALARM_ACKNOWLEDGED_EVENT = "hushh:sms-alarm-acknowledged";
const prefix = (userId: string) => `one_location_sms_alarm_v1:${encodeURIComponent(userId)}:`;
const key = (userId: string, grantId: string) => `${prefix(userId)}${encodeURIComponent(grantId)}`;
const memory = new Map<string, string>();
const failedWrites = new Set<string>();
// One record per grant avoids losing another tab's alert in a list overwrite.
function write(userId: string, grantId: string, state: "pending" | "acknowledged") {
  // Acknowledgement is a separate monotonic tombstone. A racing tab may
  // rewrite pending, but can never overwrite the recipient's acknowledgement.
  const storageKey = `${key(userId, grantId)}${state === "acknowledged" ? ":ack" : ""}`;
  memory.set(storageKey, state);
  try { localStorage.setItem(storageKey, state); failedWrites.delete(storageKey); }
  catch { failedWrites.add(storageKey); }
}

export function pendingSmsAlarms(userId: string): string[] {
  const namespace = prefix(userId);
  try {
    const stored = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i))
      .filter((storageKey): storageKey is string => !!storageKey?.startsWith(namespace) && localStorage.getItem(storageKey) === "pending")
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
  try { return localStorage.getItem(storageKey) === "acknowledged"; }
  catch { return memory.get(storageKey) === "acknowledged"; }
}

export function rememberSmsAlarm(userId: string, grantId: string): void {
  if (!userId || !grantId || isSmsAlarmAcknowledged(userId, grantId)) return;
  write(userId, grantId, "pending");
}

export function acknowledgeSmsAlarm(userId: string, grantId: string): void {
  if (!userId || !grantId) return;
  write(userId, grantId, "acknowledged");
  window.dispatchEvent(new CustomEvent(SMS_ALARM_ACKNOWLEDGED_EVENT, { detail: { userId, grantId } }));
}

/** Confirmed account deletion only; sign-out retains unacknowledged receipts. */
export function forgetSmsAlarms(userId: string): void {
  const namespace = prefix(userId);
  for (const storageKey of memory.keys()) if (storageKey.startsWith(namespace)) {
    memory.delete(storageKey); failedWrites.delete(storageKey);
  }
  for (let index = localStorage.length - 1; index >= 0; index--) {
    const storageKey = localStorage.key(index);
    if (storageKey?.startsWith(namespace)) localStorage.removeItem(storageKey);
  }
}
