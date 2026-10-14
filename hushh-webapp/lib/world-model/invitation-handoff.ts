import { ROUTES } from "@/lib/navigation/routes";

const STORAGE_PREFIX = "one.pwm.invitation-handoff.v1.";
const MAX_AGE_MS = 2 * 60 * 60 * 1000;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const NONCE_PATTERN = /^[0-9a-f]{32}$/;

type PendingInvitation = {
  version: 1;
  token: string;
  createdAt: number;
  ownerId: string | null;
};

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

function key(nonce: string): string {
  return `${STORAGE_PREFIX}${nonce}`;
}

function nonce(): string | null {
  try {
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  } catch {
    return null;
  }
}

function readEntry(store: Storage, id: string): PendingInvitation | null {
  if (!NONCE_PATTERN.test(id)) return null;
  let raw: string | null;
  try {
    raw = store.getItem(key(id));
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<PendingInvitation>;
    if (
      value.version === 1 &&
      typeof value.token === "string" &&
      TOKEN_PATTERN.test(value.token) &&
      typeof value.createdAt === "number" &&
      Number.isFinite(value.createdAt) &&
      value.createdAt <= Date.now() &&
      Date.now() - value.createdAt < MAX_AGE_MS &&
      (value.ownerId === null ||
        (typeof value.ownerId === "string" && value.ownerId.length > 0))
    ) {
      return value as PendingInvitation;
    }
  } catch {
    // An invalid or expired handoff must not continue.
  }
  try {
    store.removeItem(key(id));
  } catch {
    // Storage can become unavailable after a read.
  }
  return null;
}

/** The returned route carries only a random per-tab lookup key. */
export function createWorldModelInvitationHandoff(
  token: string,
  ownerId: string | null = null,
): string | null {
  if (!TOKEN_PATTERN.test(token)) return null;
  const store = storage();
  const id = nonce();
  if (!store || !id) return null;
  try {
    store.setItem(
      key(id),
      JSON.stringify({
        version: 1,
        token,
        createdAt: Date.now(),
        ownerId,
      } satisfies PendingInvitation),
    );
    return id;
  } catch {
    return null;
  }
}

/** Bind the first verified account; a different account cannot reuse it. */
export function readWorldModelInvitationHandoff(
  id: string,
  ownerId: string | null,
): string | null {
  const store = storage();
  if (!store) return null;
  const pending = readEntry(store, id);
  if (!pending) return null;
  if (pending.ownerId && pending.ownerId !== ownerId) {
    return null;
  }
  if (!pending.ownerId && ownerId) {
    try {
      store.setItem(key(id), JSON.stringify({ ...pending, ownerId }));
    } catch {
      return null;
    }
  }
  return pending.token;
}

/** Account changes require a separate, explicit action before token recovery. */
export function needsWorldModelInvitationAccountSwitch(
  id: string,
  ownerId: string | null,
): boolean {
  if (!ownerId) return false;
  const store = storage();
  const pending = store && readEntry(store, id);
  return Boolean(pending?.ownerId && pending.ownerId !== ownerId);
}

export function switchWorldModelInvitationHandoffAccount(
  id: string,
  ownerId: string,
): string | null {
  if (!ownerId) return null;
  const store = storage();
  if (!store) return null;
  const pending = readEntry(store, id);
  if (!pending) return null;
  try {
    store.setItem(key(id), JSON.stringify({ ...pending, ownerId }));
    return pending.token;
  } catch {
    return null;
  }
}

export function clearWorldModelInvitationHandoff(id: string): void {
  if (!NONCE_PATTERN.test(id)) return;
  try {
    storage()?.removeItem(key(id));
  } catch {
    // The token will still expire if storage is temporarily unavailable.
  }
}

/** Remove every handoff for a completed invitation, including retry copies. */
export function clearWorldModelInvitationHandoffsForToken(token: string): void {
  const store = storage();
  if (!store || !TOKEN_PATTERN.test(token)) return;
  try {
    for (let index = store.length - 1; index >= 0; index -= 1) {
      const itemKey = store.key(index);
      if (!itemKey?.startsWith(STORAGE_PREFIX)) continue;
      const id = itemKey.slice(STORAGE_PREFIX.length);
      if (readEntry(store, id)?.token === token) store.removeItem(itemKey);
    }
  } catch {
    // Completion is enforced by the server even if local cleanup fails.
  }
}

export function worldModelInvitationHandoffRoute(id: string): string {
  return `${ROUTES.WORLD_MODEL_INVITE}?handoff=${id}`;
}

export function worldModelInvitationClaimRoute(id: string): string {
  return `${ROUTES.PROFILE_WORLD_MODEL}?handoff=${id}`;
}

/** Protect direct legacy fragment entries before a guard nests them in a query. */
export function safeWorldModelInvitationReturnPath(
  path: string,
  ownerId: string | null = null,
): string {
  let url: URL;
  try {
    url = new URL(path, "https://one.local");
  } catch {
    return path.includes("claim=") ? ROUTES.WORLD_MODEL_INVITE : path;
  }
  if (
    url.pathname !== ROUTES.WORLD_MODEL_INVITE &&
    url.pathname !== ROUTES.PROFILE_WORLD_MODEL
  ) {
    return path;
  }
  const token =
    new URLSearchParams(url.hash.slice(1)).get("claim") ||
    url.searchParams.get("claim");
  if (!token) return path;
  const id = createWorldModelInvitationHandoff(token, ownerId);
  return id ? worldModelInvitationHandoffRoute(id) : ROUTES.WORLD_MODEL_INVITE;
}
