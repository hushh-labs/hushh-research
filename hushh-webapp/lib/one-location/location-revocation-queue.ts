import { OneLocationService } from "@/lib/one-location/service";

const STORAGE_PREFIX = "one_location_pending_revocations_v1";
const PUBLIC_INVITE_STORAGE_PREFIX =
  "one_location_pending_public_invite_revocations_v1";
const memoryFallback = new Map<string, string[]>();

export const ONE_LOCATION_PENDING_REVOCATIONS_CHANGED =
  "one-location-pending-revocations-changed";

export const LOCATION_REVOCATION_PENDING_MESSAGE =
  "A location share was created, but One could not confirm that it stopped yet. Updates are blocked on this device and stopping will retry automatically.";

export function pendingLocationRevocationStorageKey(userId: string): string {
  return `${STORAGE_PREFIX}:${userId}`;
}

export function pendingPublicInviteRevocationStorageKey(
  userId: string,
): string {
  return `${PUBLIC_INVITE_STORAGE_PREFIX}:${userId}`;
}

function normalizeGrantIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .map((grantId) => String(grantId ?? "").trim())
        .filter((grantId) => grantId.length > 0 && grantId.length <= 160),
    ),
  );
}

function pendingItemStoragePrefix(baseKey: string): string {
  return `${baseKey}:item:`;
}

function pendingItemStorageKey(baseKey: string, id: string): string {
  return `${pendingItemStoragePrefix(baseKey)}${encodeURIComponent(id)}`;
}

function readPendingItemIds(baseKey: string): string[] {
  if (typeof window === "undefined") return [];
  const prefix = pendingItemStoragePrefix(baseKey);
  const ids: string[] = [];
  try {
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (!key?.startsWith(prefix)) continue;
      try {
        ids.push(decodeURIComponent(key.slice(prefix.length)));
      } catch {
        // Ignore malformed browser storage written outside this module.
      }
    }
  } catch {
    return [];
  }
  return normalizeGrantIds(ids);
}

function writePendingItem(baseKey: string, id: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(pendingItemStorageKey(baseKey, id), "1");
  } catch {
    // The aggregate in-memory mirror remains fail-closed in this tab.
  }
}

function clearPendingItem(baseKey: string, id: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(pendingItemStorageKey(baseKey, id));
  } catch {
    // A failed clear is safe: a later retry may repeat an idempotent revoke.
  }
}

function readGrantIds(userId: string): string[] {
  const key = pendingLocationRevocationStorageKey(userId);
  if (typeof window === "undefined") return memoryFallback.get(key) ?? [];
  try {
    const persisted = normalizeGrantIds(
      JSON.parse(window.localStorage.getItem(key) ?? "[]"),
    );
    return normalizeGrantIds([
      ...(memoryFallback.get(key) ?? []),
      ...persisted,
      ...readPendingItemIds(key),
    ]);
  } catch {
    return memoryFallback.get(key) ?? [];
  }
}

function writeGrantIds(userId: string, grantIds: string[]): void {
  const key = pendingLocationRevocationStorageKey(userId);
  const normalized = normalizeGrantIds(grantIds);
  memoryFallback.set(key, normalized);
  if (typeof window === "undefined") {
    return;
  }
  try {
    if (normalized.length) {
      window.localStorage.setItem(key, JSON.stringify(normalized));
    } else {
      window.localStorage.removeItem(key);
    }
    // Durable storage is authoritative. Keeping a second tab-local copy after
    // a successful write would make a clear from another tab look pending
    // forever in this tab.
    memoryFallback.delete(key);
  } catch {
    // The in-memory mirror above keeps this session fail-closed when browser
    // storage is unavailable (private mode, quota, or security policy).
  }
  window.dispatchEvent(
    new CustomEvent(ONE_LOCATION_PENDING_REVOCATIONS_CHANGED, {
      detail: { userId },
    }),
  );
}

export function pendingLocationRevocationGrantIds(userId: string): Set<string> {
  return new Set(readGrantIds(userId));
}

function readPublicInviteIds(userId: string): string[] {
  const key = pendingPublicInviteRevocationStorageKey(userId);
  if (typeof window === "undefined") return memoryFallback.get(key) ?? [];
  try {
    const persisted = normalizeGrantIds(
      JSON.parse(window.localStorage.getItem(key) ?? "[]"),
    );
    return normalizeGrantIds([
      ...(memoryFallback.get(key) ?? []),
      ...persisted,
      ...readPendingItemIds(key),
    ]);
  } catch {
    return memoryFallback.get(key) ?? [];
  }
}

function writePublicInviteIds(userId: string, inviteIds: string[]): void {
  const key = pendingPublicInviteRevocationStorageKey(userId);
  const normalized = normalizeGrantIds(inviteIds);
  memoryFallback.set(key, normalized);
  if (typeof window === "undefined") return;
  try {
    if (normalized.length) {
      window.localStorage.setItem(key, JSON.stringify(normalized));
    } else {
      window.localStorage.removeItem(key);
    }
    memoryFallback.delete(key);
  } catch {
    // Keep the in-memory quarantine for this session.
  }
  window.dispatchEvent(
    new CustomEvent(ONE_LOCATION_PENDING_REVOCATIONS_CHANGED, {
      detail: { userId },
    }),
  );
}

export function pendingPublicInviteRevocationIds(
  userId: string,
): Set<string> {
  return new Set(readPublicInviteIds(userId));
}

export function requestPendingLocationRevocationRetry(userId: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent(ONE_LOCATION_PENDING_REVOCATIONS_CHANGED, {
      detail: { userId, retryRequested: true },
    }),
  );
}

function queueGrantId(userId: string, grantId: string): void {
  const baseKey = pendingLocationRevocationStorageKey(userId);
  writeGrantIds(userId, [...readGrantIds(userId), grantId]);
  // The per-item key prevents concurrent tabs from losing an ID when both
  // update the legacy aggregate array at the same time.
  writePendingItem(baseKey, grantId);
}

function clearGrantId(userId: string, grantId: string): void {
  clearPendingItem(pendingLocationRevocationStorageKey(userId), grantId);
  writeGrantIds(
    userId,
    readGrantIds(userId).filter((value) => value !== grantId),
  );
}

function isAlreadyTerminal(error: unknown): boolean {
  const status = Number((error as { status?: unknown } | null)?.status);
  return status === 404 || status === 410;
}

/** Queue first so a crash or network failure cannot re-enable publishing. */
export async function revokeLocationGrantOrQueue({
  userId,
  vaultOwnerToken,
  grantId,
}: {
  userId: string;
  vaultOwnerToken: string;
  grantId: string;
}): Promise<boolean> {
  queueGrantId(userId, grantId);
  try {
    await OneLocationService.revokeGrant({ vaultOwnerToken, grantId });
    clearGrantId(userId, grantId);
    return true;
  } catch (error) {
    if (isAlreadyTerminal(error)) {
      clearGrantId(userId, grantId);
      return true;
    }
    // A queued grant must not keep publishing through a previously-started
    // native background session while the server revoke is unconfirmed.
    await OneLocationService.stopBackgroundShare().catch(() => undefined);
    return false;
  }
}

export async function revokeLocationGrantsOrQueue({
  userId,
  vaultOwnerToken,
  grantIds,
}: {
  userId: string;
  vaultOwnerToken: string;
  grantIds: string[];
}): Promise<{ revokedGrantIds: string[]; pendingGrantIds: string[] }> {
  const uniqueGrantIds = normalizeGrantIds(grantIds);
  const attempts = await Promise.all(
    uniqueGrantIds.map(async (grantId) => ({
      grantId,
      revoked: await revokeLocationGrantOrQueue({
        userId,
        vaultOwnerToken,
        grantId,
      }),
    })),
  );
  return {
    revokedGrantIds: attempts
      .filter((attempt) => attempt.revoked)
      .map((attempt) => attempt.grantId),
    pendingGrantIds: attempts
      .filter((attempt) => !attempt.revoked)
      .map((attempt) => attempt.grantId),
  };
}

export async function retryPendingLocationRevocations({
  userId,
  vaultOwnerToken,
}: {
  userId: string;
  vaultOwnerToken: string;
}): Promise<{ revokedGrantIds: string[]; pendingGrantIds: string[] }> {
  return revokeLocationGrantsOrQueue({
    userId,
    vaultOwnerToken,
    grantIds: readGrantIds(userId),
  });
}

export async function revokePublicInviteOrQueue({
  userId,
  vaultOwnerToken,
  inviteId,
}: {
  userId: string;
  vaultOwnerToken: string;
  inviteId: string;
}): Promise<boolean> {
  const baseKey = pendingPublicInviteRevocationStorageKey(userId);
  writePublicInviteIds(userId, [...readPublicInviteIds(userId), inviteId]);
  writePendingItem(baseKey, inviteId);
  try {
    await OneLocationService.revokePublicInvite({ vaultOwnerToken, inviteId });
    clearPendingItem(baseKey, inviteId);
    writePublicInviteIds(
      userId,
      readPublicInviteIds(userId).filter((value) => value !== inviteId),
    );
    return true;
  } catch (error) {
    if (isAlreadyTerminal(error)) {
      clearPendingItem(baseKey, inviteId);
      writePublicInviteIds(
        userId,
        readPublicInviteIds(userId).filter((value) => value !== inviteId),
      );
      return true;
    }
    return false;
  }
}

export async function retryPendingPublicInviteRevocations({
  userId,
  vaultOwnerToken,
}: {
  userId: string;
  vaultOwnerToken: string;
}): Promise<{ revokedInviteIds: string[]; pendingInviteIds: string[] }> {
  const attempts = await Promise.all(
    readPublicInviteIds(userId).map(async (inviteId) => ({
      inviteId,
      revoked: await revokePublicInviteOrQueue({
        userId,
        vaultOwnerToken,
        inviteId,
      }),
    })),
  );
  return {
    revokedInviteIds: attempts
      .filter((attempt) => attempt.revoked)
      .map((attempt) => attempt.inviteId),
    pendingInviteIds: attempts
      .filter((attempt) => !attempt.revoked)
      .map((attempt) => attempt.inviteId),
  };
}
