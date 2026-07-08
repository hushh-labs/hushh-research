"use client";

import {
  ensureLocationRecipientKey,
  ensureVaultSyncedRecipientKey,
} from "@/lib/one-location/encryption";
import { OneLocationService } from "@/lib/one-location/service";
import type { OneLocationRecipient } from "@/lib/one-location/types";

/**
 * Provision the current user's One Location recipient key and register it.
 *
 * When `vaultKey` is available we use the CROSS-DEVICE vault-synced key: the
 * private key is encrypted with the vault key and stored server-side, so every
 * device the user signs into recovers the SAME keypair (adopting an existing
 * server blob, or backfilling one from this device). Without a vault key we fall
 * back to the legacy device-local key (still works on a single device).
 */
export async function bootstrapCurrentUserLocationRecipientKey(params: {
  userId: string;
  vaultOwnerToken: string;
  vaultKey?: string | null;
}): Promise<OneLocationRecipient> {
  const userId = String(params.userId || "").trim();
  const vaultOwnerToken = String(params.vaultOwnerToken || "").trim();
  const vaultKey = String(params.vaultKey || "").trim();
  if (!userId) throw new Error("Current user is required for One Location setup.");
  if (!vaultOwnerToken) throw new Error("Vault owner token required for One Location setup.");

  if (vaultKey) {
    let remoteBackup = null;
    try {
      const state = await OneLocationService.getState(vaultOwnerToken);
      remoteBackup = state.myRecipientKey ?? null;
    } catch {
      // Best-effort: the resolver falls back to the local key or generates one.
    }
    const resolved = await ensureVaultSyncedRecipientKey({
      userId,
      vaultKey,
      remoteBackup,
    });
    // Register idempotently. The backend upsert keeps the same key active and
    // COALESCEs the blob, so re-registering an already-synced key is a no-op that
    // also backfills the blob when this device generated/holds it.
    return OneLocationService.registerRecipientKey({
      vaultOwnerToken,
      keyId: resolved.keyId,
      publicKeyJwk: resolved.publicKeyJwk,
      algorithm: resolved.algorithm,
      encryptedPrivateKeyJwk: resolved.encryptedPrivateKeyJwk,
    });
  }

  const key = await ensureLocationRecipientKey(userId);
  return OneLocationService.registerRecipientKey({
    vaultOwnerToken,
    keyId: key.keyId,
    publicKeyJwk: key.publicKeyJwk,
    algorithm: key.algorithm,
  });
}
