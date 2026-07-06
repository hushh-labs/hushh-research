"use client";

/**
 * Marketplace Consent Actions Hook
 * ================================
 *
 * The shared `/consents` Access Manager renders Information Marketplace access
 * requests via the backend `MarketplaceCenterContributor`. Those rows carry
 * `metadata.request_source === "marketplace_access_request"` (see
 * `marketplace-consent.ts`).
 *
 * The generic `useConsentActions` hook approves through the developer-consent
 * pipeline, which is the WRONG backend for a marketplace slice: delivery is
 * end-to-end encrypted and must go through the dedicated marketplace approve
 * endpoint plus an envelope publish (build the slice's safe-summary export ->
 * seal it to the buyer's recipient key -> post ciphertext only). This mirrors
 * `use-one-location-consent-actions.ts`, which does the same for One Location.
 *
 * Blind relay: only the safe-summary projection of the slice is ever built, and
 * it is encrypted on-device before it leaves the browser. The server stores and
 * relays ciphertext only.
 *
 * Every successful action dispatches `CONSENT_STATE_CHANGED_EVENT` so the
 * consent center and the marketplace page stay in sync.
 */

import { useCallback, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { useVault } from "@/lib/vault/vault-context";
import { dispatchConsentStateChanged } from "@/lib/consent/consent-events";
import {
  parseMarketplaceConsentEntry,
  type MarketplaceConsentEntryRef,
} from "@/lib/consent/marketplace-consent";
import {
  buildConsentExportForScope,
  ConsentExportNoDataError,
} from "@/lib/consent/export-builder";
import { encryptSliceForRecipient } from "@/lib/one-marketplace/encryption";
import { OneMarketplaceService } from "@/lib/one-marketplace/service";
import { defaultAvailableScopeForPermission } from "@/lib/personal-knowledge-model/slice-publishing";
import { PersonalKnowledgeModelService } from "@/lib/services/personal-knowledge-model-service";
import type {
  ConsentActionKind,
  ConsentActionState,
} from "@/lib/consent/use-consent-actions";

/**
 * Minimal shape the hook needs from a `ConsentCenterEntry`. Structural so the
 * hook does not import the full consent-center service types.
 */
export interface MarketplaceConsentActionEntry {
  id: string;
  request_id?: string | null;
  scope?: string | null;
  scope_description?: string | null;
  metadata?: Record<string, unknown> | null;
}

interface UseMarketplaceConsentActionsOptions {
  /** User ID from auth context. Required to build the slice export. */
  userId?: string | null;
  /** Called after a marketplace action completes successfully. */
  onActionComplete?: () => void;
}

function actionError(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

/**
 * Resolve the canonical export scope for a requested slice. A published slice's
 * scope is `attr.<domain>.<topLevelScopePath>.*` (see
 * `defaultAvailableScopeForPermission`). The request row carries `domain` +
 * `scope_handle` but not the top-level path, so the seller resolves it from
 * their own DomainManifest scope_registry. Falls back to the domain-wide
 * `attr.<domain>` scope when the handle can't be resolved.
 */
async function resolveExportScope(params: {
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
      return defaultAvailableScopeForPermission(domain, topLevelScopePath);
    }
  } catch (error) {
    console.warn("[MarketplaceConsent] scope resolution failed:", error);
  }
  return fallback;
}

export function useMarketplaceConsentActions(
  options: UseMarketplaceConsentActionsOptions = {},
) {
  const { vaultKey, getVaultOwnerToken } = useVault();
  const { userId, onActionComplete } = options;
  const [activeActions, setActiveActions] = useState<ConsentActionState[]>([]);
  const inflight = useRef<Map<string, Promise<void>>>(new Map());

  const runWithLock = useCallback(
    (action: ConsentActionState, run: () => Promise<void>): Promise<void> => {
      const existing = inflight.current.get(action.key);
      if (existing) return existing;

      setActiveActions((current) =>
        current.some((item) => item.key === action.key)
          ? current
          : [...current, action],
      );

      const promise = (async () => {
        try {
          await run();
        } finally {
          inflight.current.delete(action.key);
          setActiveActions((current) =>
            current.filter((item) => item.key !== action.key),
          );
        }
      })();
      inflight.current.set(action.key, promise);
      return promise;
    },
    [],
  );

  const emitComplete = useCallback(
    (detail: { action: ConsentActionKind; requestId?: string; scope?: string }) => {
      onActionComplete?.();
      dispatchConsentStateChanged({
        action: detail.action,
        requestId: detail.requestId,
        scope: detail.scope,
        source: "marketplace_consent_actions",
      });
    },
    [onActionComplete],
  );

  const isRequestBusy = useCallback(
    (requestId?: string | null) => {
      const normalized = String(requestId || "").trim();
      if (!normalized) return false;
      return activeActions.some(
        (action) =>
          (action.kind === "approve" || action.kind === "deny") &&
          action.requestId === normalized,
      );
    },
    [activeActions],
  );

  const isScopeBusy = useCallback(
    (scope?: string | null) => {
      const normalized = String(scope || "").trim();
      if (!normalized) return false;
      return activeActions.some(
        (action) => action.kind === "revoke" && action.scope === normalized,
      );
    },
    [activeActions],
  );

  const activeAction = useMemo(() => activeActions[0] ?? null, [activeActions]);

  const requireToken = useCallback((): string | null => {
    const token = getVaultOwnerToken();
    if (!token) {
      toast.error("Unlock your vault to manage this marketplace request.");
      return null;
    }
    return token;
  }, [getVaultOwnerToken]);

  /**
   * Approve a marketplace access request: fetch the buyer's recipient key, build
   * the slice's safe-summary export, seal it to the buyer on-device, and post the
   * ciphertext envelope with the approval. Only the seller (owner role) can do
   * this; the backend approve endpoint is owner-scoped.
   */
  const handleApprove = useCallback(
    (entry: MarketplaceConsentActionEntry): Promise<void> => {
      const ref: MarketplaceConsentEntryRef = parseMarketplaceConsentEntry(entry);
      const requestId = ref.requestId;
      if (!requestId) {
        toast.error("This marketplace request can no longer be opened here.");
        return Promise.resolve();
      }
      const actionKey = `approve:${requestId}`;
      return runWithLock(
        { key: actionKey, kind: "approve", requestId },
        async () => {
          if (!userId || !vaultKey) {
            toast.error("Unlock your vault to approve this request.");
            return;
          }
          const vaultOwnerToken = requireToken();
          if (!vaultOwnerToken) return;

          const promise = (async () => {
            const { recipientKey } = await OneMarketplaceService.getRequestRecipientKey({
              vaultOwnerToken,
              requestId,
            });
            if (!recipientKey?.keyId || !recipientKey.publicKeyJwk) {
              throw new Error(
                "The buyer needs to open the marketplace once before approval can finish.",
              );
            }

            const scope = await resolveExportScope({
              userId,
              domain: ref.domain,
              scopeHandle: ref.scopeHandle,
              vaultOwnerToken,
            });
            if (!scope) {
              throw new Error("This slice can no longer be resolved for delivery.");
            }

            let built;
            try {
              built = await buildConsentExportForScope({
                userId,
                scope,
                vaultKey,
                vaultOwnerToken,
              });
            } catch (error) {
              if (error instanceof ConsentExportNoDataError) {
                throw new Error("There's no shareable data in this slice to deliver.");
              }
              throw error;
            }

            const envelope = await encryptSliceForRecipient({
              payload: built.payload,
              recipientPublicKeyJwk: recipientKey.publicKeyJwk,
              recipientKeyId: recipientKey.keyId,
              metadata: {
                request_id: requestId,
                scope,
                slice_name: ref.sliceName || undefined,
              },
            });

            await OneMarketplaceService.approveRequest({
              vaultOwnerToken,
              requestId,
              envelope,
            });
            return "Approved and encrypted slice delivered.";
          })();

          toast.promise(promise, {
            id: actionKey,
            loading: "Approving and delivering slice...",
            success: (message) => `✅ ${message}`,
            error: (error) => `❌ ${actionError(error, "Could not approve request.")}`,
            duration: 3000,
          });

          try {
            await promise;
            emitComplete({ action: "approve", requestId });
          } catch (error) {
            console.error("[MarketplaceConsent] approve failed:", error);
            throw error;
          }
        },
      );
    },
    [emitComplete, requireToken, runWithLock, userId, vaultKey],
  );

  /** Deny a marketplace access request. */
  const handleDeny = useCallback(
    (entry: MarketplaceConsentActionEntry): Promise<void> => {
      const ref = parseMarketplaceConsentEntry(entry);
      const requestId = ref.requestId;
      if (!requestId) {
        toast.error("This marketplace request can no longer be opened here.");
        return Promise.resolve();
      }
      const actionKey = `deny:${requestId}`;
      return runWithLock(
        { key: actionKey, kind: "deny", requestId },
        async () => {
          const vaultOwnerToken = requireToken();
          if (!vaultOwnerToken) return;

          const promise = (async () => {
            await OneMarketplaceService.denyRequest({ vaultOwnerToken, requestId });
            return "Request denied.";
          })();

          toast.promise(promise, {
            id: actionKey,
            loading: "Denying marketplace request...",
            success: (message) => `❌ ${message}`,
            error: (error) => `❌ ${actionError(error, "Could not deny request.")}`,
            duration: 3000,
          });

          try {
            await promise;
            emitComplete({ action: "deny", requestId });
          } catch (error) {
            console.error("[MarketplaceConsent] deny failed:", error);
            throw error;
          }
        },
      );
    },
    [emitComplete, requireToken, runWithLock],
  );

  return {
    handleApprove,
    handleDeny,
    activeAction,
    activeActions,
    isRequestBusy,
    isScopeBusy,
  };
}
