/**
 * Orphan guard for Plaid connections sealed in the owner's vault.
 *
 * Between the token exchange and the vault save there is a window of a few
 * seconds in which the access token exists only in this process. If the app
 * is closed inside it, Plaid keeps a live Item that no one holds a token for,
 * and because the server stores nothing it cannot clean it up.
 *
 * So the token is recorded here, encrypted with the vault key in the device's
 * secure resource cache (IndexedDB, survives an app kill), right after the
 * exchange, and cleared once the save lands. On the next unlock any record
 * still present belongs to a link that never finished: it is disconnected at
 * Plaid (never saved in the background, since the person is not here to see
 * that write) and cleared. Nothing is stored in plaintext.
 */

import { removeVaultItem } from "@/lib/kai/plaid-vault/vault-client";
import { SecureResourceCacheService } from "@/lib/services/secure-resource-cache-service";

const RESOURCE_KEY = "plaid_vault_pending_seals_v1"; // gitleaks:allow - cache record name, not a credential
// Long enough to outlive a weekend away from the app; a pending link older
// than this is still disconnected on the next unlock that reads it.
const PENDING_TTL_MS = 30 * 24 * 60 * 60 * 1000;

type PendingSeal = { itemId: string; accessToken: string; createdAt: string };
type PendingSeals = { version: 1; seals: PendingSeal[] };

async function readPending(userId: string, vaultKey: string): Promise<PendingSeal[]> {
  const record = await SecureResourceCacheService.read<PendingSeals>({
    userId,
    resourceKey: RESOURCE_KEY,
    vaultKey,
  }).catch(() => null);
  return record?.version === 1 && Array.isArray(record.seals) ? record.seals : [];
}

async function writePending(userId: string, vaultKey: string, seals: PendingSeal[]): Promise<void> {
  if (seals.length === 0) {
    await SecureResourceCacheService.invalidateResource(userId, RESOURCE_KEY);
    return;
  }
  await SecureResourceCacheService.writeRequired<PendingSeals>({
    userId,
    resourceKey: RESOURCE_KEY,
    value: { version: 1, seals },
    ttlMs: PENDING_TTL_MS,
    vaultKey,
  });
}

/** Records a freshly exchanged token until its vault save lands. Best effort. */
export async function recordPendingSeal(params: {
  userId: string;
  vaultKey: string;
  itemId: string;
  accessToken: string;
}): Promise<void> {
  try {
    const seals = (await readPending(params.userId, params.vaultKey)).filter(
      (seal) => seal.itemId !== params.itemId,
    );
    seals.push({ itemId: params.itemId, accessToken: params.accessToken, createdAt: new Date().toISOString() });
    await writePending(params.userId, params.vaultKey, seals);
  } catch {
    // Storage unavailable (for example a private browser window). The
    // in-process rollback in sealVaultPlaidConnection still covers failures
    // that do not kill the app.
  }
}

/** Clears the record once the connection is sealed or rolled back. */
export async function clearPendingSeal(params: {
  userId: string;
  vaultKey: string;
  itemId: string;
}): Promise<void> {
  try {
    const seals = await readPending(params.userId, params.vaultKey);
    const remaining = seals.filter((seal) => seal.itemId !== params.itemId);
    if (remaining.length !== seals.length) await writePending(params.userId, params.vaultKey, remaining);
  } catch {
    // Left for the next unlock, which disconnects only unsealed Items.
  }
}

export type PendingSealRecovery = { disconnected: number; alreadySealed: number; failed: number };

/**
 * On unlock: every pending record is either already sealed (just cleared) or
 * an orphan (disconnected at Plaid, then cleared). A record whose removal
 * fails is kept for the next unlock.
 */
export async function recoverPendingSeals(params: {
  userId: string;
  vaultKey: string;
  vaultOwnerToken: string;
  sealedItemIds: ReadonlySet<string>;
}): Promise<PendingSealRecovery> {
  const outcome: PendingSealRecovery = { disconnected: 0, alreadySealed: 0, failed: 0 };
  const seals = await readPending(params.userId, params.vaultKey);
  if (seals.length === 0) return outcome;
  const keep: PendingSeal[] = [];
  for (const seal of seals) {
    if (params.sealedItemIds.has(seal.itemId)) {
      outcome.alreadySealed += 1;
      continue;
    }
    try {
      await removeVaultItem({ vaultOwnerToken: params.vaultOwnerToken, accessToken: seal.accessToken });
      outcome.disconnected += 1;
    } catch {
      outcome.failed += 1;
      keep.push(seal);
    }
  }
  await writePending(params.userId, params.vaultKey, keep);
  return outcome;
}
