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
}): Promise<MarketplaceRecipient> {
  const userId = String(params.userId || "").trim();
  const vaultOwnerToken = String(params.vaultOwnerToken || "").trim();
  if (!userId) throw new Error("Current user is required for marketplace setup.");
  if (!vaultOwnerToken) throw new Error("Vault owner token required for marketplace setup.");

  const key = await ensureMarketplaceRecipientKey(userId);
  return OneMarketplaceService.registerRecipientKey({
    vaultOwnerToken,
    keyId: key.keyId,
    publicKeyJwk: key.publicKeyJwk,
    algorithm: key.algorithm,
  });
}
