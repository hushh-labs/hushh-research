"use client";

import { ensureLocationRecipientKey } from "@/lib/one-location/encryption";
import { OneLocationService } from "@/lib/one-location/service";
import type { OneLocationRecipient } from "@/lib/one-location/types";

export async function bootstrapCurrentUserLocationRecipientKey(params: {
  userId: string;
  vaultOwnerToken: string;
}): Promise<OneLocationRecipient> {
  const userId = String(params.userId || "").trim();
  const vaultOwnerToken = String(params.vaultOwnerToken || "").trim();
  if (!userId) throw new Error("Current user is required for One Location setup.");
  if (!vaultOwnerToken) throw new Error("Vault owner token required for One Location setup.");

  const key = await ensureLocationRecipientKey(userId);
  return OneLocationService.registerRecipientKey({
    vaultOwnerToken,
    keyId: key.keyId,
    publicKeyJwk: key.publicKeyJwk,
    algorithm: key.algorithm,
  });
}
