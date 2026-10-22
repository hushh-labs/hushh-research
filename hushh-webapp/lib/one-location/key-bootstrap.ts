"use client";

import {
  ensureLocationRecipientKey,
  ensureVaultSyncedRecipientKey,
} from "@/lib/one-location/encryption";
import { LocationBus } from "@/lib/one-location/location-bus";
import { OneLocationService } from "@/lib/one-location/service";
import type { OneLocationRecipient } from "@/lib/one-location/types";
import { isVaultSessionEpochCurrent, snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { isValidatedAuthSessionOwnerCurrent, snapshotValidatedAuthSessionOwner } from "@/lib/auth/session-owner";

type BootstrapParams = {
  userId: string;
  vaultOwnerToken: string;
  vaultKey?: string | null;
  strictRecovery?: boolean;
};

// Warm-up, onboarding and Location can mount together. Key creation/recovery
// must have one writer per account; credentials remain in memory only.
const pendingByUser = new Map<string, {
  params: BootstrapParams;
  epoch: number;
  ownerGeneration?: number;
  promise: Promise<OneLocationRecipient>;
}>();

export function bootstrapCurrentUserLocationRecipientKey(params: BootstrapParams): Promise<OneLocationRecipient> {
  const userId = String(params.userId || "").trim();
  const epoch = snapshotVaultSessionEpoch();
  const owner = snapshotValidatedAuthSessionOwner();
  const normalized = { ...params, userId, strictRecovery: params.strictRecovery ?? Boolean(params.vaultKey) };
  const assertCurrent = () => {
    if (!isVaultSessionEpochCurrent(epoch) ||
        (owner ? owner.userId !== userId || !isValidatedAuthSessionOwnerCurrent(owner) : snapshotValidatedAuthSessionOwner() !== null)) {
      throw new Error("Location setup session changed. Please retry after unlocking.");
    }
  };
  const previous = pendingByUser.get(userId);
  if (previous && previous.epoch === epoch && previous.ownerGeneration === owner?.generation && previous.params.vaultOwnerToken === params.vaultOwnerToken &&
      previous.params.vaultKey === params.vaultKey &&
      (previous.params.strictRecovery || !normalized.strictRecovery)) return previous.promise;

  const run = () => provisionRecipientKey(normalized, assertCurrent);
  const promise = previous ? previous.promise.catch(() => undefined).then(run) : run();
  const entry = { params: normalized, epoch, ownerGeneration: owner?.generation, promise };
  pendingByUser.set(userId, entry);
  const release = () => { if (pendingByUser.get(userId) === entry) pendingByUser.delete(userId); };
  void promise.then(release, release);
  return promise;
}

/**
 * Provision the current user's One Location recipient key and register it.
 *
 * When `vaultKey` is available we use the CROSS-DEVICE vault-synced key: the
 * private key is encrypted with the vault key and stored server-side, so every
 * device the user signs into recovers the SAME keypair (adopting an existing
 * server blob, or backfilling one from this device). Without a vault key we fall
 * back to the legacy device-local key (still works on a single device).
 */
async function provisionRecipientKey(params: BootstrapParams, assertCurrent: () => void): Promise<OneLocationRecipient> {
  const userId = String(params.userId || "").trim();
  const vaultOwnerToken = String(params.vaultOwnerToken || "").trim();
  const vaultKey = String(params.vaultKey || "").trim();
  if (!userId) throw new Error("Current user is required for One Location setup.");
  if (!vaultOwnerToken) throw new Error("Vault owner token required for One Location setup.");
  assertCurrent();

  // Bind the shared bus to this account, so a fix survives the page.
  //
  // Here rather than in a component because this is the one function that
  // already runs on every signed-in Location surface — the hub, the invite
  // page, the chat, and the unlock warm path — which is what makes the memory
  // global instead of one screen's private cache.
  //
  // Deliberately not awaited, and deliberately before the key work below. The
  // sealing key is read from IndexedDB, where any device that has something to
  // restore already has it, so hydration usually resolves without waiting for
  // registration. If it does lose the race it simply restores nothing this
  // time: `readLastKnownFix` treats an unopenable record as absent rather than
  // deleting it, so nothing is lost either way.
  void LocationBus.attachUser(userId);

  if (vaultKey) {
    let remoteBackup = null;
    try {
      const state = await OneLocationService.getState(vaultOwnerToken);
      assertCurrent();
      if (params.strictRecovery && !Object.prototype.hasOwnProperty.call(state, "myRecipientKey")) {
        throw new Error("Location receiving key could not be checked.");
      }
      remoteBackup = state.myRecipientKey ?? null;
    } catch (error) {
      if (params.strictRecovery) throw error;
      // Best-effort: the resolver falls back to the local key or generates one.
    }
    assertCurrent();
    const resolved = await ensureVaultSyncedRecipientKey({
      userId,
      vaultKey,
      remoteBackup,
      strictRecovery: params.strictRecovery,
    });
    assertCurrent();
    // Register idempotently. The backend upsert keeps the same key active and
    // COALESCEs the blob, so re-registering an already-synced key is a no-op that
    // also backfills the blob when this device generated/holds it.
    const registered = await OneLocationService.registerRecipientKey({
      vaultOwnerToken,
      keyId: resolved.keyId,
      publicKeyJwk: resolved.publicKeyJwk,
      algorithm: resolved.algorithm,
      encryptedPrivateKeyJwk: resolved.encryptedPrivateKeyJwk,
    });
    assertCurrent();
    return registered;
  }

  const key = await ensureLocationRecipientKey(userId);
  assertCurrent();
  const registered = await OneLocationService.registerRecipientKey({
    vaultOwnerToken,
    keyId: key.keyId,
    publicKeyJwk: key.publicKeyJwk,
    algorithm: key.algorithm,
  });
  assertCurrent();
  return registered;
}
