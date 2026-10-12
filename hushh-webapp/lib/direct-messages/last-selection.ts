/** The last Messages view is scoped to this signed-in owner and browser tab. */
export type LastMessagesSelection =
  | { lane: "people"; token: string | null }
  | { lane: "circles"; circleId: string | null };

const KEY_PREFIX = "one.messages.selection.v1:";
const CHANGE_EVENT = "one-messages-last-selection-change";

function storageKey(ownerId: string): string {
  return `${KEY_PREFIX}${encodeURIComponent(ownerId)}`;
}

export function parseLastMessagesSelection(value: string): LastMessagesSelection | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object") return null;
    const selection = parsed as Record<string, unknown>;
    if (selection.lane === "people" &&
      (selection.token === null ||
        (typeof selection.token === "string" && selection.token.length > 0 && selection.token.length <= 4096))) {
      return { lane: "people", token: selection.token as string | null };
    }
    if (selection.lane === "circles" &&
      (selection.circleId === null ||
        (typeof selection.circleId === "string" && selection.circleId.length > 0 && selection.circleId.length <= 256))) {
      return { lane: "circles", circleId: selection.circleId as string | null };
    }
  } catch { /* Discard invalid or unavailable saved state. */ }
  return null;
}

export function readLastMessagesSelection(ownerId: string | null | undefined): string {
  if (!ownerId || typeof window === "undefined") return "";
  try {
    return window.sessionStorage.getItem(storageKey(ownerId)) ?? "";
  } catch {
    return "";
  }
}

export function subscribeLastMessagesSelection(listener: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, listener);
  return () => window.removeEventListener(CHANGE_EVENT, listener);
}

export function writeLastMessagesSelection(
  ownerId: string | null | undefined,
  selection: LastMessagesSelection | null,
): void {
  if (!ownerId || typeof window === "undefined") return;
  try {
    if (selection) window.sessionStorage.setItem(storageKey(ownerId), JSON.stringify(selection));
    else window.sessionStorage.removeItem(storageKey(ownerId));
  } catch { /* Chat remains usable when browser storage is disabled. */ }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}
