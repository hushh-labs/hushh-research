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

import { useCallback, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useVault } from "@/lib/vault/vault-context";
import { ApiService } from "@/lib/services/api-service";
import { CacheSyncService } from "@/lib/cache/cache-sync-service";
import { dispatchConsentStateChanged } from "@/lib/consent/consent-events";
import {
  buildConsentExportForScope,
  ConsentExportNoDataError,
} from "@/lib/consent/export-builder";
import { ROUTES } from "@/lib/navigation/routes";
import { oneLocationErrorMessage } from "@/lib/one-location/error-message";
import { requestInternalAppNavigation } from "@/lib/utils/browser-navigation";

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
  notificationOpenedAt?: number;
  notificationAcknowledged?: boolean;
}

type RequestStatus = "pending" | "handling" | "handled";
export type ConsentActionKind = "approve" | "deny" | "revoke";

export interface ConsentActionState {
  key: string;
  kind: ConsentActionKind;
  requestId?: string;
  scope?: string;
}

export interface ConsentMutationDetail {
  action: ConsentActionKind;
  requestId?: string;
  scope?: string;
  source: "consent_actions";
}

interface UseConsentActionsOptions {
  /** User ID from auth context (replaces sessionStorage lookup) */
  userId?: string | null;
  /** Called after approve/deny/revoke completes successfully */
  onActionComplete?: (detail: ConsentMutationDetail) => void;
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

/** The message field of one error envelope, or null when there is none. */
function envelopeMessage(body: string): string | null {
  try {
    const parsed = JSON.parse(body);
    if (typeof parsed?.error === "string") {
      return parsed.error;
    }
    if (typeof parsed?.detail === "string") {
      return parsed.detail;
    }
    if (typeof parsed?.detail?.message === "string") {
      return parsed.detail.message;
    }
  } catch {
    // Not JSON: the caller keeps the raw body.
  }
  return null;
}

/**
 * Lift the message out of an error body so a JSON envelope never becomes the
 * thrown text.
 *
 * The Next.js routes wrap the backend body verbatim (`{ error: responseText }`)
 * and the backend raises `HTTPException(detail=...)`, so the message often
 * sits two envelopes deep: `{"error":"{\"detail\":\"...\"}"}`. Peel until a
 * plain string remains. What comes out is the backend's or the route's own
 * sentence, kept on the thrown error for the console and for callers; it is
 * never what the owner reads (see `ownerFacingConsentError`).
 */
function extractConsentActionError(errorText: string, fallback: string): string {
  let message = errorText;
  // Two envelopes is the real shape today; the bound only stops a pathological
  // body from looping.
  for (let depth = 0; depth < 3; depth += 1) {
    const inner = envelopeMessage(message);
    if (inner === null) break;
    message = inner;
  }
  return message || fallback;
}

/**
 * A sentence this hook wrote for the owner. The only kind of error a consent
 * toast shows verbatim.
 *
 * Every other error (a backend `detail`, a route's own generic string, a
 * driver error, a stack trace) reads as the action's fallback. The backend
 * writes for developers ("User ID does not match authenticated user", "Token
 * validation failed.", bare status codes) and the revoke route answers its own
 * catch with `Internal server error: ${error}`; all of those are short and
 * marker-free, so a deny-list rule let them through. Allow-listing by type
 * cannot be fooled by a new sentence.
 */
class OwnerFacingConsentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OwnerFacingConsentError";
  }
}

/**
 * The sentence a toast may show for a failed action.
 *
 * Only an `OwnerFacingConsentError` passes, and even then through
 * `oneLocationErrorMessage`, the one rule in this repo for what may cross the
 * vault boundary, so the hook's own sentences are held to the same bar as
 * every other surface.
 */
function ownerFacingConsentError(error: unknown, fallback: string): string {
  if (!(error instanceof OwnerFacingConsentError)) return fallback;
  return oneLocationErrorMessage(error, fallback);
}

/**
 * The error a quiet caller receives.
 *
 * A quiet caller owns the reporting and may put the message in front of the
 * owner (the chat transcript does), so the thrown message is the same
 * owner-facing sentence a toast would have shown: a sentence this hook wrote
 * verbatim, anything else the action's fallback. The peeled backend or route
 * sentence rides along as `cause` for the console and for callers that log
 * it; it is never the message.
 */
function quietConsentError(error: unknown, fallback: string): Error {
  return new Error(ownerFacingConsentError(error, fallback), { cause: error });
}

const APPROVE_FAILED = "Could not allow this. Nothing was shared.";
const DENY_FAILED = "Could not decline this. Try again.";
const REVOKE_FAILED = "Could not stop sharing. Try again.";
const NOTHING_TO_SHARE = "There is nothing to share for this yet. Nothing was shared.";

// ============================================================================
// Hook
// ============================================================================

export function useConsentActions(options: UseConsentActionsOptions = {}) {
  const { vaultKey, getVaultOwnerToken } = useVault();
  const { userId, onActionComplete } = options;
  const [activeActions, setActiveActions] = useState<ConsentActionState[]>([]);
  const inflightActionPromises = useRef<Map<string, Promise<void>>>(new Map());

  // Track request status: ID -> "pending" | "handling" | "handled"
  // Using ref to persist across renders without causing re-renders
  const requestStatusMap = useRef<Map<string, RequestStatus>>(new Map());

  const runWithActionLock = useCallback(
    (action: ConsentActionState, run: () => Promise<void>): Promise<void> => {
      const existing = inflightActionPromises.current.get(action.key);
      if (existing) return existing;

      setActiveActions((current) =>
        current.some((item) => item.key === action.key)
          ? current
          : [...current, action]
      );

      const promise = (async () => {
        try {
          await run();
        } finally {
          inflightActionPromises.current.delete(action.key);
          setActiveActions((current) =>
            current.filter((item) => item.key !== action.key)
          );
        }
      })();
      inflightActionPromises.current.set(action.key, promise);
      return promise;
    },
    []
  );

  const emitSuccessfulMutation = useCallback(
    (detail: Omit<ConsentMutationDetail, "source">) => {
      if (!userId) return;
      const eventDetail: ConsentMutationDetail = {
        ...detail,
        source: "consent_actions",
      };
      CacheSyncService.onConsentMutated(userId);
      onActionComplete?.(eventDetail);
      dispatchConsentStateChanged({ ...eventDetail });
    },
    [onActionComplete, userId]
  );

  const isRequestBusy = useCallback(
    (requestId?: string | null) => {
      const normalized = String(requestId || "").trim();
      if (!normalized) return false;
      return activeActions.some(
        (action) =>
          (action.kind === "approve" || action.kind === "deny") &&
          action.requestId === normalized
      );
    },
    [activeActions]
  );

  const isScopeBusy = useCallback(
    (scope?: string | null) => {
      const normalized = String(scope || "").trim();
      if (!normalized) return false;
      return activeActions.some(
        (action) => action.kind === "revoke" && action.scope === normalized
      );
    },
    [activeActions]
  );

  const activeAction = useMemo(() => activeActions[0] ?? null, [activeActions]);

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
    (consent: PendingConsent, options?: { quiet?: boolean }): Promise<void> => {
      const actionKey = `approve:${consent.id}`;
      return runWithActionLock(
        { key: actionKey, kind: "approve", requestId: consent.id },
        async () => {
      const toastId = consent.id;

      // Mark as handling immediately to block re-showing
      markAsHandling(consent.id);

      if (!userId || !vaultKey) {
        toast.error("Vault not unlocked. Unlock your vault to approve this request.", {
          id: toastId,
          
          duration: 6000,
          action: {
            label: "Unlock",
            onClick: () => {
              requestInternalAppNavigation({ href: ROUTES.KAI_HOME, scroll: false });
            },
          },
        });
        // Reset to pending if not unlocked
        markAsPending(consent.id);
        return;
      }

      const promise = (async () => {
        const vaultOwnerToken = getVaultOwnerToken();
        if (!vaultOwnerToken) {
          throw new OwnerFacingConsentError("Unlock your vault first.");
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
              throw new OwnerFacingConsentError(
                "Could not prepare this. Unlock your vault and try again."
              );
            }
            if (err instanceof ConsentExportNoDataError) {
              // The builder's sentences name what it could not build, in
              // developer words; the owner only needs to know nothing left.
              console.warn("[Consent] Export unavailable", err.diagnostics || { stage: "eligible_scope" });
              throw new OwnerFacingConsentError(NOTHING_TO_SHARE);
            }
            console.error("[Consent] PKM export build failed", { errorClass: err instanceof Error ? err.name : "UnknownError" });
            throw new OwnerFacingConsentError(
              "Could not load your saved details. Try again."
            );
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
        const {
          buildConsentExportAadV2,
          buildConsentExportEnvelopeSubmissionV2,
          canonicalConsentExportAad,
          canonicalConsentExportJson,
        } = await import("@/lib/consent/export-envelope-v2");
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
          throw new OwnerFacingConsentError(
            "This app needs to send the request again before you can allow it."
          );
        }
        const exportKey = await generateExportKey();
        const requestedDurationHours =
          consent.durationHours ||
          (typeof consentMetadata.expiry_hours === "number"
            ? consentMetadata.expiry_hours
            : Number(consentMetadata.expiry_hours || 24));
        const exportAad = isDeveloperRequest
          ? await buildConsentExportAadV2({
              appId: String(consentMetadata.developer_app_id || ""),
              grantId: consent.id,
              machineScope: consent.scope,
              scopeHandle: String(consentMetadata.scope_handle || ""),
              connectorPublicKey,
              expiresAtMs: Date.now() + requestedDurationHours * 60 * 60 * 1000,
            })
          : null;
        const encrypted = await encryptForExport(
          JSON.stringify(scopeData),
          exportKey,
          exportAad ? { additionalData: canonicalConsentExportAad(exportAad) } : undefined
        );
        const exportEnvelope = exportAad
          ? await buildConsentExportEnvelopeSubmissionV2({
              aad: exportAad,
              ciphertextBase64: encrypted.ciphertext,
            })
          : undefined;
        const wrappedKeyBundle = connectorPublicKey
          ? await wrapExportKeyForConnector({
              exportKeyHex: exportKey,
              connectorPublicKey,
              connectorKeyId,
              additionalData: exportEnvelope
                ? canonicalConsentExportJson(exportEnvelope)
                : undefined,
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
          exportEnvelope,
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(extractConsentActionError(errorText, APPROVE_FAILED));
        }

        return "Allowed. They can open it now.";
      })();

      if (!options?.quiet) {
        toast.promise(promise, {
          id: toastId,
          loading: "Allowing...",
          success: (data) => data,
          error: (err) => ownerFacingConsentError(err, APPROVE_FAILED),
          duration: 3000,
        });
      }

      try {
        await promise;
        markAsHandled(consent.id);
        emitSuccessfulMutation({ action: "approve", requestId: consent.id });
      } catch (err) {
        console.error("Error approving consent", { errorClass: err instanceof Error ? err.name : "UnknownError" });
        markAsPending(consent.id);
        if (options?.quiet) {
          throw quietConsentError(err, APPROVE_FAILED);
        }
      }
        }
      );
    },
    [
      emitSuccessfulMutation,
      getVaultOwnerToken,
      markAsHandled,
      markAsHandling,
      markAsPending,
      runWithActionLock,
      userId,
      vaultKey,
    ]
  );

  /**
   * Deny a consent request
   */
  const handleDeny = useCallback(
    (requestId: string, options?: { quiet?: boolean }): Promise<void> => {
      const actionKey = `deny:${requestId}`;
      return runWithActionLock(
        { key: actionKey, kind: "deny", requestId },
        async () => {
      const toastId = requestId;

      if (!userId) return;

      // Mark as handling immediately
      markAsHandling(requestId);

      const promise = (async () => {
        const vaultOwnerToken = getVaultOwnerToken();
        if (!vaultOwnerToken) {
          throw new OwnerFacingConsentError("Unlock your vault first.");
        }

        const response = await ApiService.denyPendingConsent({
          userId,
          requestId,
          vaultOwnerToken,
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(extractConsentActionError(errorText, DENY_FAILED));
        }

        return "Declined. Nothing was shared.";
      })();

      if (!options?.quiet) {
        toast.promise(promise, {
          id: toastId,
          loading: "Declining...",
          success: (data) => data,
          error: (err) => ownerFacingConsentError(err, DENY_FAILED),
          duration: 3000,
        });
      }

      try {
        await promise;
        markAsHandled(requestId);
        emitSuccessfulMutation({ action: "deny", requestId });
      } catch (err) {
        console.error("Error denying consent:", err);
        markAsPending(requestId);
        if (options?.quiet) {
          throw quietConsentError(err, DENY_FAILED);
        }
      }
        }
      );
    },
    [
      emitSuccessfulMutation,
      getVaultOwnerToken,
      markAsHandled,
      markAsHandling,
      markAsPending,
      runWithActionLock,
      userId,
    ]
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
        return "Allowed. They can open it now.";
      })();

      toast.promise(promise, {
        id: toastId,
        loading: "Allowing...",
        success: (data) => data,
        error: (err) => ownerFacingConsentError(err, APPROVE_FAILED),
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
        return "Declined. Nothing was shared.";
      })();

      toast.promise(promise, {
        id: toastId,
        loading: "Declining...",
        success: (data) => data,
        error: (err) => ownerFacingConsentError(err, DENY_FAILED),
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
    (
      scope: string,
      requestId?: string | null,
      options?: { quiet?: boolean },
    ): Promise<void> => {
      const normalizedScope = scope.trim();
      const actionKey = `revoke:${normalizedScope}`;
      return runWithActionLock(
        { key: actionKey, kind: "revoke", scope: normalizedScope },
        async () => {
      if (!userId) return;

      const promise = (async () => {
        const vaultOwnerToken = getVaultOwnerToken();
        const response = await ApiService.revokeConsent({
          userId,
          scope: normalizedScope,
          requestId: String(requestId || "").trim() || undefined,
          // Revoke is consent-gated; always include the VAULT_OWNER token explicitly.
          // (On native builds, relying on sessionStorage can be flaky across webview lifecycles.)
          token: vaultOwnerToken || "",
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(extractConsentActionError(errorText, REVOKE_FAILED));
        }

        // Check if backend signals to lock vault (for VAULT_OWNER revocation)
        const data = await response.json();
        return data;
      })();

      if (!options?.quiet) {
        toast.promise(promise, {
          id: actionKey,
          loading: "Stopping...",
          success: () => "Sharing stopped.",
          error: (err) => ownerFacingConsentError(err, REVOKE_FAILED),
          duration: 3000,
        });
      }

      try {
        const result = await promise;
        
        // If VAULT_OWNER was revoked, lock the vault
        if (result.lockVault) {
          // Dispatch event so VaultContext can react
          window.dispatchEvent(new CustomEvent("vault-lock-requested", {
            detail: { reason: "VAULT_OWNER token revoked" }
          }));
          
          toast.info("Vault locked", {
            
            duration: 5000,
          });
        }
        
        emitSuccessfulMutation({ action: "revoke", scope: normalizedScope });
      } catch (err) {
        console.error("Error revoking consent:", err);
        // Quiet callers own the reporting, so they have to be told. Without
        // this the promise resolves identically whether the grant was revoked
        // or the request 500'd, and a caller that speaks the outcome -- the
        // agent handler does -- would tell someone their access was taken
        // back when it was not. handleDeny already rethrows under `quiet`
        // for the same reason.
        if (options?.quiet) {
          throw quietConsentError(err, REVOKE_FAILED);
        }
      }
        }
      );
    },
    [emitSuccessfulMutation, getVaultOwnerToken, runWithActionLock, userId]
  );

  return {
    // Actions
    handleApprove,
    handleApproveBundle,
    handleDeny,
    handleDenyBundle,
    handleRevoke,
    activeAction,
    activeActions,
    isRequestBusy,
    isScopeBusy,

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
