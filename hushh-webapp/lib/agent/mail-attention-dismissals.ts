/**
 * Per-viewer Mail attention choices on this device. Only opaque state keys and
 * times are stored: never a merchant, amount, field label, sender, subject,
 * workflow id or any other Mail content. UserLocalStateService removes the
 * record on sign-out, account switch, Reset and deletion.
 */
const STORAGE_PREFIX = "hushh.mail_attention.v1.";
const MAX_ENTRIES = 200;
const STATE_KEY = /^[0-9a-z]{14}$/;
export const MAIL_ATTENTION_SNOOZE_MS = 24 * 60 * 60 * 1000;

type Entries = Readonly<Record<string, number>>;
export type MailAttentionDismissals = { readonly snoozed: Entries; readonly done: Entries };

const EMPTY: MailAttentionDismissals = { snoozed: {}, done: {} };
// One read per owner per page; later reads and failed writes stay consistent.
const memory = new Map<string, MailAttentionDismissals>();
const listeners = new Set<() => void>();

export function mailAttentionStorageKey(ownerId: string): string {
  return `${STORAGE_PREFIX}${ownerId}`;
}

function fnv1a(value: string, basis: number): string {
  let hash = basis;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36).padStart(7, "0");
}

/** Opaque key for one item in one state. A changed state is a new key. */
export function mailAttentionStateKey(id: string, state: string): string {
  const value = `${id}\u0000${state}`;
  return fnv1a(value, 0x811c9dc5) + fnv1a(value, 0x050c5d1f);
}

function validEntries(value: unknown): Entries {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const entries = Object.entries(value).filter(
    (entry): entry is [string, number] =>
      STATE_KEY.test(entry[0]) && typeof entry[1] === "number" && Number.isFinite(entry[1]),
  );
  return Object.fromEntries(entries.slice(0, MAX_ENTRIES));
}

export function readMailAttentionDismissals(ownerId: string | null): MailAttentionDismissals {
  if (!ownerId || typeof window === "undefined") return EMPTY;
  const held = memory.get(ownerId);
  if (held) return held;
  let value = EMPTY;
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(mailAttentionStorageKey(ownerId)) || "{}");
    const record = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    value = { snoozed: validEntries(record.snoozed), done: validEntries(record.done) };
  } catch {
    // Storage disabled or unreadable: start empty for this page.
  }
  memory.set(ownerId, value);
  return value;
}

export function isMailAttentionHidden(dismissals: MailAttentionDismissals, stateKey: string, now: number): boolean {
  if (Object.hasOwn(dismissals.done, stateKey)) return true;
  return Object.hasOwn(dismissals.snoozed, stateKey) && (dismissals.snoozed[stateKey] ?? 0) > now;
}

function newest(entries: Entries): Entries {
  return Object.fromEntries(Object.entries(entries).sort((left, right) => right[1] - left[1]).slice(0, MAX_ENTRIES));
}

function write(ownerId: string, next: MailAttentionDismissals, now: number): void {
  const live = Object.fromEntries(Object.entries(next.snoozed).filter(([, until]) => until > now));
  const value = { snoozed: newest(live), done: newest(next.done) };
  memory.set(ownerId, value);
  try {
    window.localStorage.setItem(mailAttentionStorageKey(ownerId), JSON.stringify(value));
  } catch {
    // Storage disabled: the choice still holds for this page.
  }
  listeners.forEach((listener) => listener());
}

/** Hide one item state for 24 hours. */
export function snoozeMailAttention(ownerId: string, stateKey: string, now: number): void {
  if (!ownerId || !STATE_KEY.test(stateKey) || typeof window === "undefined") return;
  const current = readMailAttentionDismissals(ownerId);
  write(ownerId, { ...current, snoozed: { ...current.snoozed, [stateKey]: now + MAIL_ATTENTION_SNOOZE_MS } }, now);
}

/** Hide one item state until it changes. */
export function markMailAttentionDone(ownerId: string, stateKey: string, now: number): void {
  if (!ownerId || !STATE_KEY.test(stateKey) || typeof window === "undefined") return;
  const current = readMailAttentionDismissals(ownerId);
  write(ownerId, { ...current, done: { ...current.done, [stateKey]: now } }, now);
}

/** Undo either choice for one item state. */
export function restoreMailAttention(ownerId: string, stateKey: string, now: number): void {
  if (!ownerId || typeof window === "undefined") return;
  const current = readMailAttentionDismissals(ownerId);
  const snoozed: Record<string, number> = { ...current.snoozed };
  const done: Record<string, number> = { ...current.done };
  delete snoozed[stateKey];
  delete done[stateKey];
  write(ownerId, { snoozed, done }, now);
}

/** Sign-out, account switch, Reset and deletion remove this owner's record. */
export function forgetMailAttentionDismissals(ownerId: string): void {
  if (!ownerId || typeof window === "undefined") return;
  memory.delete(ownerId);
  try {
    window.localStorage.removeItem(mailAttentionStorageKey(ownerId));
  } catch {
    // Storage disabled: nothing is kept to remove.
  }
  listeners.forEach((listener) => listener());
}

export function subscribeMailAttentionDismissals(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
