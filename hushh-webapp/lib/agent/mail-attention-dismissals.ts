/**
 * Per-viewer Mail attention choices on this device. Only opaque state keys and
 * times are stored: never a merchant, amount, field label, sender, subject,
 * workflow id or any other Mail content. Each owner has their own record; like
 * Feed's device state it survives sign-out, and UserLocalStateService removes
 * it on Reset and account deletion.
 */
const STORAGE_PREFIX = "hushh.mail_attention.v1.";
const MAX_ENTRIES = 200;
const STATE_KEY = /^[0-9a-z]{14}$/;
export const MAIL_ATTENTION_SNOOZE_MS = 24 * 60 * 60 * 1000;

type Entries = Readonly<Record<string, number>>;
export type MailAttentionDismissals = { readonly snoozed: Entries; readonly done: Entries };
type Choice = (current: MailAttentionDismissals) => MailAttentionDismissals;

const EMPTY: MailAttentionDismissals = { snoozed: {}, done: {} };
// This page's copy for renders. Storage is the source of truth: writes read it
// fresh, and another tab's change drops the copy.
const memory = new Map<string, MailAttentionDismissals>();
// Choices storage refused (full or disabled). They are replayed over every
// read until a write lands or a Reset removes the record.
const unsaved = new Map<string, readonly Choice[]>();
const listeners = new Set<() => void>();
let listening = false;

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

/** The record as stored now, or null when storage cannot be read. */
function readStored(ownerId: string): MailAttentionDismissals | null {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(mailAttentionStorageKey(ownerId)) || "{}");
    const record = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    return { snoozed: validEntries(record.snoozed), done: validEntries(record.done) };
  } catch {
    return null;
  }
}

function notify(): void {
  listeners.forEach((listener) => listener());
}

/**
 * Storage as it is now, so another tab's choice or Reset is kept, with this
 * page's unsaved choices replayed over it. This page's copy stands in only
 * when storage cannot be read.
 */
function latest(ownerId: string): MailAttentionDismissals {
  const base = readStored(ownerId) ?? memory.get(ownerId) ?? EMPTY;
  return (unsaved.get(ownerId) ?? []).reduce((value, choice) => choice(value), base);
}

/**
 * Another tab changed a record, or cleared storage: re-read it on next render.
 * A removed record is a Reset or deletion, which unsaved choices do not outlive.
 */
function onStorage({ key, newValue }: StorageEvent): void {
  if (key === null) {
    memory.clear();
    unsaved.clear();
  } else if (key.startsWith(STORAGE_PREFIX)) {
    const ownerId = key.slice(STORAGE_PREFIX.length);
    memory.delete(ownerId);
    if (newValue === null) unsaved.delete(ownerId);
  } else {
    return;
  }
  notify();
}

/**
 * Holds this page's copy. The storage listener comes with the first copy and
 * stays for the page's life: a copy kept while nothing listened, such as while
 * the stack is unmounted, would miss another tab's choice or Reset.
 */
function remember(ownerId: string, value: MailAttentionDismissals): MailAttentionDismissals {
  memory.set(ownerId, value);
  if (!listening) {
    window.addEventListener("storage", onStorage);
    listening = true;
  }
  return value;
}

export function readMailAttentionDismissals(ownerId: string | null): MailAttentionDismissals {
  if (!ownerId || typeof window === "undefined") return EMPTY;
  return memory.get(ownerId) ?? remember(ownerId, latest(ownerId));
}

export function isMailAttentionHidden(dismissals: MailAttentionDismissals, stateKey: string, now: number): boolean {
  if (Object.hasOwn(dismissals.done, stateKey)) return true;
  return Object.hasOwn(dismissals.snoozed, stateKey) && (dismissals.snoozed[stateKey] ?? 0) > now;
}

function newest(entries: Entries): Entries {
  return Object.fromEntries(Object.entries(entries).sort((left, right) => right[1] - left[1]).slice(0, MAX_ENTRIES));
}

function write(ownerId: string, choice: Choice, now: number): void {
  const next = choice(latest(ownerId));
  const live = Object.fromEntries(Object.entries(next.snoozed).filter(([, until]) => until > now));
  const value = { snoozed: newest(live), done: newest(next.done) };
  remember(ownerId, value);
  try {
    window.localStorage.setItem(mailAttentionStorageKey(ownerId), JSON.stringify(value));
    unsaved.delete(ownerId);
  } catch {
    // Storage full or disabled: the choice holds for this page, and later
    // choices replay it because storage never received it.
    unsaved.set(ownerId, [...(unsaved.get(ownerId) ?? []), choice]);
  }
  notify();
}

/** Hide one item state for 24 hours. */
export function snoozeMailAttention(ownerId: string, stateKey: string, now: number): void {
  if (!ownerId || !STATE_KEY.test(stateKey) || typeof window === "undefined") return;
  write(ownerId, (current) => ({ ...current, snoozed: { ...current.snoozed, [stateKey]: now + MAIL_ATTENTION_SNOOZE_MS } }), now);
}

/** Hide one item state until it changes. */
export function markMailAttentionDone(ownerId: string, stateKey: string, now: number): void {
  if (!ownerId || !STATE_KEY.test(stateKey) || typeof window === "undefined") return;
  write(ownerId, (current) => ({ ...current, done: { ...current.done, [stateKey]: now } }), now);
}

/** Undo either choice for one item state. */
export function restoreMailAttention(ownerId: string, stateKey: string, now: number): void {
  if (!ownerId || typeof window === "undefined") return;
  write(ownerId, (current) => {
    const snoozed: Record<string, number> = { ...current.snoozed };
    const done: Record<string, number> = { ...current.done };
    delete snoozed[stateKey];
    delete done[stateKey];
    return { snoozed, done };
  }, now);
}

/** Reset and account deletion remove this owner's record; sign-out keeps it. */
export function forgetMailAttentionDismissals(ownerId: string): void {
  if (!ownerId || typeof window === "undefined") return;
  memory.delete(ownerId);
  unsaved.delete(ownerId);
  const key = mailAttentionStorageKey(ownerId);
  try {
    // Write before removing so other tabs always hear a change, even when this
    // owner's record was never saved; removing a missing key is silent.
    window.localStorage.setItem(key, "{}");
  } catch {
    // A full store refuses the write; the removal below still runs.
  }
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Storage disabled: nothing is kept to remove.
  }
  notify();
}

export function subscribeMailAttentionDismissals(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
