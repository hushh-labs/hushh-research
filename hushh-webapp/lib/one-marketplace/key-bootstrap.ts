"use client";

import { ensureMarketplaceRecipientKey } from "@/lib/one-marketplace/encryption";
import { OneMarketplaceService } from "@/lib/one-marketplace/service";
import type { MarketplaceRecipient } from "@/lib/one-marketplace/service";

/**
 * Ensure the current user has a marketplace recipient key on this device and its
 * public half is published, so any seller can deliver a slice to them. Mirrors
 * One Location's `bootstrapCurrentUserLocationRecipientKey`. Idempotent.
 */
export async function bootstrapCurrentUserMarketplaceRecipientKey(params: {
  userId: string;
  vaultOwnerToken: string;
  isCurrent?: () => boolean;
}): Promise<MarketplaceRecipient> {
  const userId = String(params.userId || "").trim();
  const vaultOwnerToken = String(params.vaultOwnerToken || "").trim();
  if (!userId) throw new Error("Current user is required for marketplace setup.");
  if (!vaultOwnerToken) throw new Error("Vault owner token required for marketplace setup.");

  let retired = false;
  const assertCurrent = () => {
    if (retired || params.isCurrent && !params.isCurrent()) throw new Error("Session changed. Reopen this request.");
  };
  assertCurrent();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      retired = true;
      reject(new Error("Secure receiving setup timed out. Check this device's storage and connection, then retry."));
    }, 15_000);
  });
  const setup = async () => {
    const key = await ensureMarketplaceRecipientKey(userId);
    assertCurrent();
    const registered = await OneMarketplaceService.registerRecipientKey({
      vaultOwnerToken,
      keyId: key.keyId,
      publicKeyJwk: key.publicKeyJwk,
      algorithm: key.algorithm,
    });
    assertCurrent();
    if (registered?.userId !== userId || registered.keyId !== key.keyId ||
        registered.algorithm !== key.algorithm ||
        registered.publicKeyJwk?.kty !== key.publicKeyJwk.kty ||
        registered.publicKeyJwk?.crv !== key.publicKeyJwk.crv ||
        registered.publicKeyJwk?.x !== key.publicKeyJwk.x ||
        registered.publicKeyJwk?.y !== key.publicKeyJwk.y) {
      throw new Error("Secure receiving could not be verified. Retry setup.");
    }
    return registered;
  };
  try {
    return await Promise.race([setup(), timeout]);
  } finally {
    retired = true;
    clearTimeout(timer);
  }
}
