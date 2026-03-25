"use client";

/**
 * Consent Actions Hook - Centralized Approve/Deny/Revoke Logic
 * =============================================================
 *
 * Provides a unified interface for consent actions that:
 * - Coordinates with seenRequestIds state to prevent toast re-showing
 * - Uses toast.promise for loading → success/error transitions
 * - Triggers data refresh after action completion
 */

import { useCallback, useRef } from "react";
import { toast } from "sonner";
import { useVault } from "@/lib/vault/vault-context";
import { ApiService } from "@/lib/services/api-service";
import { CacheSyncService } from "@/lib/cache/cache-sync-service";
import { buildConsentExportForScope } from "@/lib/consent/export-builder";

// ============================================================================
// Types
// ============================================================================

export interface PendingConsent {
  id: string;
  developer: string;
  developerImageUrl?: string;
  developerWebsiteUrl?: string;
  scope: string;
  scopeDescription?: string;
  requestedAt: number;
  approvalTimeoutAt?: number;
  expiryHours?: number;
  durationHours?: number;
  bundleId?: string;
  requestUrl?: string;
  reason?: string;
  isScopeUpgrade?: boolean;
  existingGrantedScopes?: string[];
  additionalAccessSummary?: string;
  metadata?: Record<string, unknown> | null;
}

type RequestStatus = "pending" | "handling" | "handled";

interface UseConsentActionsOptions {
  /** User ID from auth context (replaces sessionStorage lookup) */
  userId?: string | null;
  /** Called after approve/deny/revoke completes successfully */
  onActionComplete?: () => void;
}

// ============================================================================
// Helpers: Scope detection and vault data endpoint
// ============================================================================

/** pkm.read or attr.{domain}.* (domain: alphanumeric + underscore only) */
const PKM_READ = "pkm.read";

function isPkmScope(scope: string): boolean {
  return scope === PKM_READ || scope.startsWith("attr.");
}

function getScopeDataEndpoint(scope: string): string | null {
  const scopeMap: Record<string, string> = {
    // Dynamic attr.* scopes (canonical)
    "attr.financial.*": "/api/vault/finance",
  };
  return scopeMap[scope] || null;
}

// ============================================================================
// Hook
// ============================================================================

export function useConsentActions(options: UseConsentActionsOptions = {}) {
  const { vaultKey, getVaultOwnerToken } = useVault();
  const { userId, onActionComplete } = options;

  // Track request status: ID -> "pending" | "handling" | "handled"
  // Using ref to persist across renders without causing re-renders
  const requestStatusMap = useRef<Map<string, RequestStatus>>(new Map());

  /**
   * Get current status of a request
   */
  const getRequestStatus = useCallback(
    (requestId: string): RequestStatus | undefined => {
      return requestStatusMap.current.get(requestId);
    },
    []
  );

  /**
   * Mark a request as being handled (blocks toast re-showing)
   */
  const markAsHandling = useCallback((requestId: string) => {
    requestStatusMap.current.set(requestId, "handling");
  }, []);

  /**
   * Mark a request as fully handled (can be cleaned up)
   */
  const markAsHandled = useCallback((requestId: string) => {
    requestStatusMap.current.set(requestId, "handled");
  }, []);

  /**
   * Mark a request as pending (shown but not actioned)
   */
  const markAsPending = useCallback((requestId: string) => {
    requestStatusMap.current.set(requestId, "pending");
  }, []);

  /**
   * Remove tracking for a request
   */
  const clearRequest = useCallback((requestId: string) => {
    requestStatusMap.current.delete(requestId);
  }, []);

  /**
   * Check if we should show a toast for this request
   */
  const shouldShowToast = useCallback((requestId: string): boolean => {
    const status = requestStatusMap.current.get(requestId);
    // Show only if not tracked yet
    return !status;
  }, []);

  /**
   * Check if we should dismiss a toast for this request
   * (Only dismiss if still "pending", not if "handling" or "handled")
   */
  const shouldDismissToast = useCallback((requestId: string): boolean => {
    const status = requestStatusMap.current.get(requestId);
    return status === "pending";
  }, []);

  /**
   * Approve a consent request with zero-knowledge export
   */
  const handleApprove = useCallback(
    async (consent: PendingConsent, options?: { quiet?: boolean }): Promise<void> => {
      const toastId = consent.id;

      // Mark as handling immediately to block re-showing
      markAsHandling(consent.id);

      if (!userId || !vaultKey) {
        toast.error("Vault not unlocked", {
          id: toastId,
          description: "Please unlock your vault to approve this request.",
          duration: 3000,
        });
        // Reset to pending if not unlocked
        markAsPending(consent.id);
        return;
      }

      const promise = (async () => {
        const vaultOwnerToken = getVaultOwnerToken();
        if (!vaultOwnerToken) {
          throw new Error("Vault owner token required");
        }

        let scopeData: Record<string, unknown> = {};
        let sourceContentRevision: number | undefined;
        let sourceManifestRevision: number | undefined;

        // PKM scopes: build export from encrypted PKM storage (BYOK)
        if (isPkmScope(consent.scope)) {
          try {
            const builtExport = await buildConsentExportForScope({
              userId,
              scope: consent.scope,
              vaultKey,
              vaultOwnerToken,
            });
            scopeData = builtExport.payload;
            sourceContentRevision = builtExport.sourceContentRevision;
            sourceManifestRevision = builtExport.sourceManifestRevision;
          } catch (err) {
            if (err instanceof SyntaxError) {
              console.error("[Consent] Failed to parse PKM blob after decrypt");
              throw new Error("Could not prepare export; check vault.");
            }
            console.error("[Consent] PKM export build failed:", err);
            throw new Error("Could not load your data; try again.");
          }
        }

        // Legacy vault/finance endpoint mapping
        const scopeDataEndpoint = getScopeDataEndpoint(consent.scope);
        if (scopeDataEndpoint && Object.keys(scopeData).length === 0) {
          // Identify which API method to call based on scope
          let dataResponse: Response | null = null;

          console.log("[NativeDebug] Fetching scope data for:", consent.scope);

          try {
            // Scope mapping to ApiService methods (food/professional removed; use PKM)
            if (consent.scope.includes("finance")) {
              // Legacy finance endpoint if needed
              console.warn("Finance scope: legacy endpoint not yet populated");
            }
          } catch (e: unknown) {
            console.error("[NativeDebug] ApiService.getData error:", e);
            // Proceed without data if fetch fails, but log it.
            // Are we throwing here? No, caught.
          }

          const response = dataResponse as Response | null;
          if (response?.ok) {
            console.log("[NativeDebug] Scope data fetched successfully");
            const data = await response.json();

            // Decrypt the data with vault key
            const { decryptData } = await import("@/lib/vault/encrypt");
            const decryptedFields: Record<string, unknown> = {};

            // Handle object format
            const preferences = data.preferences || data.data || {};

            if (
              preferences &&
              typeof preferences === "object" &&
              !Array.isArray(preferences)
            ) {
              for (const [fieldName, encryptedField] of Object.entries(
                preferences
              )) {
                try {
                  const field = encryptedField as {
                    ciphertext: string;
                    iv: string;
                    tag: string;
                    algorithm?: string;
                    encoding?: string;
                  };
                  const decrypted = await decryptData(
                    {
                      ciphertext: field.ciphertext,
                      iv: field.iv,
                      tag: field.tag,
                      encoding: (field.encoding || "base64") as "base64",
                      algorithm: (field.algorithm ||
                        "aes-256-gcm") as "aes-256-gcm",
                    },
                    vaultKey
                  );
                  decryptedFields[fieldName] = JSON.parse(decrypted);
                } catch (err) {
                  console.warn(`Failed to decrypt field: ${fieldName}`, err);
                }
              }
            } else if (Array.isArray(preferences)) {
              // Array format (legacy)
              for (const field of preferences) {
                try {
                  const decrypted = await decryptData(
                    {
                      ciphertext: field.ciphertext,
                      iv: field.iv,
                      tag: field.tag,
                      encoding: "base64",
                      algorithm: "aes-256-gcm",
                    },
                    vaultKey
                  );
                  decryptedFields[field.field_name] = JSON.parse(decrypted);
                } catch {
                  console.warn(`Failed to decrypt field: ${field.field_name}`);
                }
              }
            }

            scopeData = decryptedFields;
          } else {
            // On native, specific endpoints might not exist yet for all scopes.
            // We gracefully handle failure, but for 'Food' and 'Professional' it should work.
            console.warn(
              "[NativeDebug] Failed to fetch scope data or scope not supported:",
              consent.scope
            );
          }
        }

        if (Object.keys(scopeData).length === 0 && !isPkmScope(consent.scope) && !getScopeDataEndpoint(consent.scope)) {
          console.info("[Consent] Unknown scope, approving with empty export:", consent.scope);
        }

        console.log("[NativeDebug] Generating export key...");
        // Generate export key and encrypt
        const { generateExportKey, encryptForExport, wrapExportKeyForConnector } = await import(
          "@/lib/vault/export-encrypt"
        );
        const consentMetadata =
          consent.metadata && typeof consent.metadata === "object"
            ? (consent.metadata as Record<string, unknown>)
            : {};
        const connectorPublicKey =
          typeof consentMetadata.connector_public_key === "string"
            ? consentMetadata.connector_public_key
            : "";
        const connectorKeyId =
          typeof consentMetadata.connector_key_id === "string"
            ? consentMetadata.connector_key_id
            : undefined;
        const requesterActorType =
          typeof consentMetadata.requester_actor_type === "string"
            ? consentMetadata.requester_actor_type
            : "";
        const requestSource =
          typeof consentMetadata.request_source === "string"
            ? consentMetadata.request_source
            : "";
        const isDeveloperRequest =
          Boolean(connectorPublicKey) ||
          requesterActorType === "developer" ||
          requestSource === "developer_api_v1";
        if (isDeveloperRequest && !connectorPublicKey) {
          throw new Error(
            "This developer request is missing a connector public key and must be re-requested."
          );
        }
        const exportKey = await generateExportKey();
        const encrypted = await encryptForExport(
          JSON.stringify(scopeData),
          exportKey
        );
        const wrappedKeyBundle = connectorPublicKey
          ? await wrapExportKeyForConnector({
              exportKeyHex: exportKey,
              connectorPublicKey,
              connectorKeyId,
            })
          : null;

        console.log("[NativeDebug] Submitting approval to backend...");
        // Send to server
        const response = await ApiService.approvePendingConsent({
          userId,
          requestId: consent.id,
          vaultOwnerToken,
          encryptedData: encrypted.ciphertext,
          encryptedIv: encrypted.iv,
          encryptedTag: encrypted.tag,
          wrappedExportKey: wrappedKeyBundle?.wrappedExportKey,
          wrappedKeyIv: wrappedKeyBundle?.wrappedKeyIv,
          wrappedKeyTag: wrappedKeyBundle?.wrappedKeyTag,
          senderPublicKey: wrappedKeyBundle?.senderPublicKey,
          wrappingAlg: wrappedKeyBundle?.wrappingAlg,
          connectorKeyId: wrappedKeyBundle?.connectorKeyId,
          sourceContentRevision,
          sourceManifestRevision,
          durationHours: consent.durationHours,
        });

        if (!response.ok) {
          const errorText = await response.text();
          console.error("[NativeDebug] Approval failed:", errorText);
          throw new Error(errorText || "Failed to approve");
        }

        return "Consent approved!";
      })();

      if (!options?.quiet) {
        toast.promise(promise, {
          id: toastId,
          loading: "Approving consent...",
          success: (data) => `✅ ${data}`,
          error: (err) => `❌ ${err.message}`,
          duration: 3000,
        });
      }

      try {
        await promise;
        markAsHandled(consent.id);
        CacheSyncService.onConsentMutated(userId);
        onActionComplete?.();

        // Dispatch custom event so consents page can refresh tables
        window.dispatchEvent(
          new CustomEvent("consent-action-complete", {
            detail: { action: "approve", requestId: consent.id },
          })
        );
      } catch (err) {
        console.error("Error approving consent:", err);
        markAsPending(consent.id);
        if (options?.quiet) {
          throw (err instanceof Error ? err : new Error("Failed to approve consent"));
        }
      }
    },
    [userId, vaultKey, getVaultOwnerToken, markAsHandling, markAsHandled, markAsPending, onActionComplete]
  );

  /**
   * Deny a consent request
   */
  const handleDeny = useCallback(
    async (requestId: string, options?: { quiet?: boolean }): Promise<void> => {
      const toastId = requestId;

      if (!userId) return;

      // Mark as handling immediately
      markAsHandling(requestId);

      const promise = (async () => {
        const vaultOwnerToken = getVaultOwnerToken();
        if (!vaultOwnerToken) {
          throw new Error("Vault owner token required");
        }

        const response = await ApiService.denyPendingConsent({
          userId,
          requestId,
          vaultOwnerToken,
        });

        if (!response.ok) {
          throw new Error("Failed to deny consent");
        }

        return "Consent denied";
      })();

      if (!options?.quiet) {
        toast.promise(promise, {
          id: toastId,
          loading: "Denying consent...",
          success: (data) => `❌ ${data}`,
          error: (err) => `❌ ${err.message}`,
          duration: 3000,
        });
      }

      try {
        await promise;
        markAsHandled(requestId);
        CacheSyncService.onConsentMutated(userId);
        onActionComplete?.();

        // Dispatch custom event so consents page can refresh tables
        window.dispatchEvent(
          new CustomEvent("consent-action-complete", {
            detail: { action: "deny", requestId },
          })
        );
      } catch (err) {
        console.error("Error denying consent:", err);
        markAsPending(requestId);
        if (options?.quiet) {
          throw (err instanceof Error ? err : new Error("Failed to deny consent"));
        }
      }
    },
    [userId, getVaultOwnerToken, markAsHandling, markAsHandled, markAsPending, onActionComplete]
  );

  const handleApproveBundle = useCallback(
    async (
      consents: PendingConsent[],
      options?: { bundleId?: string; bundleLabel?: string }
    ): Promise<void> => {
      if (!userId || consents.length === 0) return;
      const toastId = options?.bundleId || `bundle-${consents[0]?.id || "approve"}`;
      const promise = (async () => {
        for (const consent of consents) {
          await handleApprove(consent, { quiet: true });
        }
        return "Consent bundle approved";
      })();

      toast.promise(promise, {
        id: toastId,
        loading: `Approving ${options?.bundleLabel || "request bundle"}...`,
        success: "✅ Request bundle approved",
        error: (err) => `❌ ${err.message}`,
        duration: 3000,
      });

      await promise;
    },
    [handleApprove, userId]
  );

  const handleDenyBundle = useCallback(
    async (
      requestIds: string[],
      options?: { bundleId?: string; bundleLabel?: string }
    ): Promise<void> => {
      if (!userId || requestIds.length === 0) return;
      const toastId = options?.bundleId || `bundle-${requestIds[0] || "deny"}`;
      const promise = (async () => {
        for (const requestId of requestIds) {
          await handleDeny(requestId, { quiet: true });
        }
        return "Consent bundle denied";
      })();

      toast.promise(promise, {
        id: toastId,
        loading: `Denying ${options?.bundleLabel || "request bundle"}...`,
        success: "❌ Request bundle denied",
        error: (err) => `❌ ${err.message}`,
        duration: 3000,
      });

      await promise;
    },
    [handleDeny, userId]
  );

  /**
   * Revoke an active consent
   * For VAULT_OWNER scope, this will also lock the vault
   */
  const handleRevoke = useCallback(
    async (scope: string): Promise<void> => {
      if (!userId) return;

      const promise = (async () => {
        const vaultOwnerToken = getVaultOwnerToken();
        const response = await ApiService.revokeConsent({
          userId,
          scope,
          // Revoke is consent-gated; always include the VAULT_OWNER token explicitly.
          // (On native builds, relying on sessionStorage can be flaky across webview lifecycles.)
          token: vaultOwnerToken || "",
        });

        if (!response.ok) {
          throw new Error("Failed to revoke consent");
        }

        // Check if backend signals to lock vault (for VAULT_OWNER revocation)
        const data = await response.json();
        return data;
      })();

      toast.promise(promise, {
        loading: "Revoking consent...",
        success: () => `🔒 Consent revoked`,
        error: (err) => `❌ ${err.message}`,
        duration: 3000,
      });

      try {
        const result = await promise;
        
        // If VAULT_OWNER was revoked, lock the vault
        if (result.lockVault) {
          // Dispatch event so VaultContext can react
          window.dispatchEvent(new CustomEvent("vault-lock-requested", {
            detail: { reason: "VAULT_OWNER token revoked" }
          }));
          
          toast.info("Vault locked", {
            description: "Your VAULT_OWNER access has been revoked. Please unlock again to continue.",
            duration: 5000,
          });
        }
        
        CacheSyncService.onConsentMutated(userId);
        onActionComplete?.();
      } catch (err) {
        console.error("Error revoking consent:", err);
      }
    },
    [userId, getVaultOwnerToken, onActionComplete]
  );

  return {
    // Actions
    handleApprove,
    handleApproveBundle,
    handleDeny,
    handleDenyBundle,
    handleRevoke,

    // Status management
    getRequestStatus,
    markAsPending,
    markAsHandling,
    markAsHandled,
    clearRequest,
    shouldShowToast,
    shouldDismissToast,
  };
}
