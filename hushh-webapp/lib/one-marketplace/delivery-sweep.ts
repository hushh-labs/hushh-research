"use client";

/**
 * Seller-side marketplace delivery sweep.
 *
 * Agent-driven approvals (Agent One over A2A, or the marketplace chat agent) run
 * server-side with no browser, so they can only flip a request to `approved` —
 * they cannot seal the encrypted slice (that needs the seller's unlocked vault +
 * WebCrypto). This sweep is the fulfilment half: the next time the seller's
 * device is unlocked, it finds those approved-but-undelivered requests, seals
 * each slice on-device against the buyer's recipient key, and posts ciphertext
 * to the deliver endpoint. Blind relay preserved — the server only ever relays
 * sealed envelopes.
 */

import { OneMarketplaceService } from "@/lib/one-marketplace/service";
import {
  RecipientKeyUnavailableError,
  sealSliceForRequest,
} from "@/lib/one-marketplace/seal-delivery";

export interface DeliverySweepParams {
  /** The seller (owner) whose approved requests are being fulfilled. */
  userId: string;
  /** The seller's vault key, needed to build the slice export on-device. */
  vaultKey: string;
  vaultOwnerToken: string;
}

export interface DeliverySweepResult {
  delivered: number;
  skipped: number;
}

/**
 * Deliver every approved-but-undelivered request the caller owns. Best-effort
 * and idempotent: requests that already have an envelope are ignored, per-request
 * failures are logged and skipped so one bad request never blocks the rest, and
 * requests whose buyer hasn't published a recipient key yet are left for a later
 * sweep (no error).
 */
export async function runMarketplaceDeliverySweep(
  params: DeliverySweepParams,
): Promise<DeliverySweepResult> {
  const approved = await OneMarketplaceService.listRequests({
    vaultOwnerToken: params.vaultOwnerToken,
    role: "owner",
    status: "approved",
  });
  const pending = approved.filter((request) => !request.latestEnvelopeId);

  let delivered = 0;
  let skipped = 0;
  for (const request of pending) {
    try {
      const envelope = await sealSliceForRequest({
        userId: params.userId,
        vaultKey: params.vaultKey,
        vaultOwnerToken: params.vaultOwnerToken,
        requestId: request.id,
        domain: request.domain ?? "",
        scopeHandle: request.scopeHandle ?? "",
        sliceName: request.sliceName,
      });
      await OneMarketplaceService.deliverRequest({
        vaultOwnerToken: params.vaultOwnerToken,
        requestId: request.id,
        envelope,
      });
      delivered += 1;
    } catch (error) {
      skipped += 1;
      // Buyer has no published key yet — a later sweep (after they open the
      // marketplace) will complete it. Not an error worth surfacing.
      if (error instanceof RecipientKeyUnavailableError) continue;
      console.warn(
        "[MarketplaceDeliverySweep] could not deliver request",
        request.id,
        error,
      );
    }
  }
  return { delivered, skipped };
}
