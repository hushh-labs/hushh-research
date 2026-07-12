"use client";

/**
 * Shared "seal a slice for one request" logic for the Information Marketplace.
 *
 * The same on-device sealing runs from two places:
 *   1. Interactive approval in the Consent Guardian
 *      (`use-marketplace-consent-actions.ts`) — approve + deliver in one step.
 *   2. The headless delivery sweep (`delivery-sweep.ts`) — fulfil requests an
 *      agent (A2A / marketplace chat) already approved without a browser to seal.
 *
 * Both need the identical sequence: fetch the buyer's recipient key, resolve the
 * export scope, build the slice's safe-summary export, and seal it against the
 * buyer's public key. Blind relay: only the safe-summary projection is built and
 * it is encrypted on-device before it ever leaves the browser.
 */

import {
  buildConsentExportForScope,
  ConsentExportNoDataError,
} from "@/lib/consent/export-builder";
import {
  encryptSliceForRecipient,
  type MarketplaceEncryptedEnvelope,
} from "@/lib/one-marketplace/encryption";
import { OneMarketplaceService } from "@/lib/one-marketplace/service";
import { consentScopeForPermission } from "@/lib/personal-knowledge-model/slice-publishing";
import { PersonalKnowledgeModelService } from "@/lib/services/personal-knowledge-model-service";

/**
 * Resolve the canonical export scope for a requested slice. A published slice's
 * scope is `attr.<domain>.<topLevelScopePath>.*` (see
 * `consentScopeForPermission`). The request row carries `domain` +
 * `scope_handle` but not the top-level path, so the seller resolves it from
 * their own DomainManifest scope_registry. Falls back to the domain-wide
 * `attr.<domain>` scope when the handle can't be resolved.
 */
export async function resolveExportScope(params: {
  userId: string;
  domain: string;
  scopeHandle: string;
  vaultOwnerToken: string;
}): Promise<string | null> {
  const domain = params.domain.trim();
  const scopeHandle = params.scopeHandle.trim();
  // A scope_handle that is already a full attr scope can be used as-is.
  if (scopeHandle.startsWith("attr.")) return scopeHandle;
  if (!domain) return scopeHandle || null;

  const fallback = `attr.${domain}`;
  if (!scopeHandle) return fallback;

  try {
    const manifest = await PersonalKnowledgeModelService.getDomainManifest(
      params.userId,
      domain,
      params.vaultOwnerToken,
    );
    const entry = manifest?.scope_registry?.find(
      (candidate) => candidate.scope_handle === scopeHandle,
    );
    const topLevelScopePath = String(
      entry?.summary_projection?.top_level_scope_path || "",
    ).trim();
    if (topLevelScopePath) {
      return consentScopeForPermission(domain, topLevelScopePath);
    }
  } catch (error) {
    console.warn("[MarketplaceSeal] scope resolution failed:", error);
  }
  return fallback;
}

/**
 * Error thrown when the buyer has not yet published a recipient key. The caller
 * should treat this as "retry later" (the buyer needs to open the marketplace
 * once), NOT as a hard failure.
 */
export class RecipientKeyUnavailableError extends Error {
  constructor() {
    super("The buyer needs to open the marketplace once before approval can finish.");
    this.name = "RecipientKeyUnavailableError";
  }
}

export interface SealSliceForRequestParams {
  /** The seller (owner) resolving the request. */
  userId: string;
  /** The seller's vault key, used to decrypt their own data to build the export. */
  vaultKey: string;
  vaultOwnerToken: string;
  requestId: string;
  domain: string;
  scopeHandle: string;
  sliceName?: string;
}

/**
 * Seal one request's slice against the buyer's recipient key and return the
 * ciphertext envelope. Does NOT touch the request status — the caller decides
 * whether to approve+deliver (Consent Guardian) or deliver-only (sweep).
 *
 * Throws `RecipientKeyUnavailableError` when the buyer has no published key
 * (retry later), or a plain `Error` for unrecoverable problems (no resolvable
 * scope, no shareable data).
 */
export async function sealSliceForRequest(
  params: SealSliceForRequestParams,
): Promise<MarketplaceEncryptedEnvelope> {
  const { recipientKey } = await OneMarketplaceService.getRequestRecipientKey({
    vaultOwnerToken: params.vaultOwnerToken,
    requestId: params.requestId,
  });
  if (!recipientKey?.keyId || !recipientKey.publicKeyJwk) {
    throw new RecipientKeyUnavailableError();
  }

  const scope = await resolveExportScope({
    userId: params.userId,
    domain: params.domain,
    scopeHandle: params.scopeHandle,
    vaultOwnerToken: params.vaultOwnerToken,
  });
  if (!scope) {
    throw new Error("This slice can no longer be resolved for delivery.");
  }

  let built;
  try {
    built = await buildConsentExportForScope({
      userId: params.userId,
      scope,
      vaultKey: params.vaultKey,
      vaultOwnerToken: params.vaultOwnerToken,
    });
  } catch (error) {
    if (error instanceof ConsentExportNoDataError) {
      throw new Error("There's no shareable data in this slice to deliver.");
    }
    throw error;
  }

  return encryptSliceForRecipient({
    payload: built.payload,
    recipientPublicKeyJwk: recipientKey.publicKeyJwk,
    recipientKeyId: recipientKey.keyId,
    metadata: {
      request_id: params.requestId,
      scope,
      slice_name: params.sliceName || undefined,
    },
  });
}
