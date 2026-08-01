"use client";

/**
 * One Location Consent Actions Hook
 * =================================
 *
 * The shared `/one/consent` Access Manager renders One Location rows (live
 * location requests, share grants, public links) via the backend
 * `OneLocationCenterContributor`. Those rows carry `metadata.request_source`
 * starting with `one_location` (see `location-consent.ts`).
 *
 * The generic `useConsentActions` hook approves/denies/revokes through the
 * developer-consent pipeline (`ApiService.approvePendingConsent` etc.), which is
 * the WRONG backend for One Location: a location grant is end-to-end encrypted
 * and must go through the dedicated One Location endpoints plus an envelope
 * publish (capture position -> encrypt to the requester's recipient key -> store
 * envelope). That is exactly what the One Location page's Activity actions do.
 *
 * This hook re-uses the *same* flow as `hushh-webapp/app/one/location/page.tsx`
 * so the Allow / Don't allow / Revoke CTAs in the consent manager behave
 * identically to the Activity tab on the One Location page. Both surfaces stay
 * in sync because every successful action dispatches
 * `CONSENT_STATE_CHANGED_EVENT`, which both the consent center and the One
 * Location page already listen to.
 */

import { useCallback, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { useVault } from "@/lib/vault/vault-context";
import { dispatchConsentStateChanged } from "@/lib/consent/consent-events";
import {
  parseLocationConsentEntry,
  type LocationConsentEntryRef,
} from "@/lib/consent/location-consent";
import { encryptLocationForRecipient } from "@/lib/one-location/encryption";
import { OneLocationService } from "@/lib/one-location/service";
import {
  approvedLocationCommitStrictlyMatches,
  prepareLocationPointForSharing,
} from "@/lib/one-location/location-precision";
import type { LocationSharingMode } from "@/lib/one-location/types";
import {
  enableOneLocationAutomaticUpdates,
  readOneLocationControlState,
} from "@/lib/one-location/location-control-state";
import {
  LOCATION_REVOCATION_PENDING_MESSAGE,
  revokeLocationGrantOrQueue,
  revokePublicInviteOrQueue,
} from "@/lib/one-location/location-revocation-queue";
import type {
  ConsentActionKind,
  ConsentActionState,
} from "@/lib/consent/use-consent-actions";

/**
 * Minimal shape the hook needs from a `ConsentCenterEntry`. Kept structural so
 * the hook does not have to import the full consent-center service types.
 */
export interface LocationConsentActionEntry {
  id: string;
  request_id?: string | null;
  scope?: string | null;
  metadata?: Record<string, unknown> | null;
}

interface UseOneLocationConsentActionsOptions {
  /** User ID from auth context. Required to decrypt/own the action. */
  userId?: string | null;
  /** Called after a One Location action completes successfully. */
  onActionComplete?: () => void;
}

function clampApprovalDurationHours(durationHours?: number): number {
  // The consent-manager duration picker offers values in hours. One Location's
  // backend clamps to its own policy window, so we only guard against missing /
  // non-positive input here and let the server enforce the real ceiling.
  if (!Number.isFinite(durationHours) || !durationHours || durationHours <= 0) {
    return 24;
  }
  return durationHours;
}

function actionError(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function useOneLocationConsentActions(
  options: UseOneLocationConsentActionsOptions = {},
) {
  const { getVaultOwnerToken } = useVault();
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
    (detail: {
      action: ConsentActionKind;
      requestId?: string;
      scope?: string;
    }) => {
      onActionComplete?.();
      // Both the consent center and the One Location page listen for this event,
      // so a CTA in either surface refreshes the other.
      dispatchConsentStateChanged({
        action: detail.action,
        requestId: detail.requestId,
        scope: detail.scope,
        source: "one_location_consent_actions",
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
      toast.error("Unlock your vault to manage this location request.");
      return null;
    }
    return token;
  }, [getVaultOwnerToken]);

  /**
   * Approve a One Location access request: open the dedicated grant, capture the
   * owner's current position, encrypt it to the requester's recipient key, and
   * publish the envelope. Mirrors `handleApprove` in the One Location page.
   */
  const handleApprove = useCallback(
    (
      entry: LocationConsentActionEntry,
      durationHours?: number,
      locationMode: LocationSharingMode = "approximate",
    ): Promise<void> => {
      const ref = parseLocationConsentEntry(entry);
      const requestId = ref.requestId;
      if (!requestId) {
        toast.error("This location request can no longer be opened here.");
        return Promise.resolve();
      }
      const actionKey = `approve:${requestId}`;
      return runWithLock(
        { key: actionKey, kind: "approve", requestId },
        async () => {
          if (!userId) return;
          if (readOneLocationControlState(userId).paused) {
            throw new Error(
              "Location is paused on this device. Resume it before approving.",
            );
          }
          const vaultOwnerToken = requireToken();
          if (!vaultOwnerToken) return;

          const promise = (async () => {
            const state = await OneLocationService.getState(vaultOwnerToken);
            const request = state.requests.find(
              (item) => item.id === requestId,
            );
            if (!request) {
              throw new Error("This location request is no longer available.");
            }
            const connectedRequester = state.recipients.find(
              (recipient) => recipient.userId === request.requesterUserId,
            );
            const requesterKeyId =
              request.requesterKeyId ?? connectedRequester?.keyId;
            const requesterPublicKeyJwk =
              request.requesterPublicKeyJwk ?? connectedRequester?.publicKeyJwk;
            if (!requesterKeyId || !requesterPublicKeyJwk) {
              throw new Error(
                "They need to open Location once before approval can finish.",
              );
            }
            const point = await OneLocationService.captureCurrentPosition();
            const permission = await OneLocationService.getPermissionState();
            if (readOneLocationControlState(userId).paused) {
              throw new Error(
                "Location was paused before the request could be approved.",
              );
            }
            if (locationMode === "precise" && permission.precise === false) {
              throw new Error(
                "Turn on Precise Location in device settings to approve a live location.",
              );
            }
            const sharePoint = prepareLocationPointForSharing(
              point,
              locationMode,
            );
            const envelope = await encryptLocationForRecipient({
              point: sharePoint,
              recipientPublicKeyJwk: requesterPublicKeyJwk,
              recipientKeyId: requesterKeyId,
            });
            const confirmedAt = new Date().toISOString();
            const response = await OneLocationService.approveRequest({
              vaultOwnerToken,
              requestId,
              durationHours: clampApprovalDurationHours(durationHours),
              recipientKeyId: requesterKeyId,
              clientOperationId: `approval:${requestId}:${confirmedAt}`,
              confirmedAt,
              envelope,
              locationMode,
              approximateRadiusM: sharePoint.approximateRadiusM ?? null,
            });
            if (
              !approvedLocationCommitStrictlyMatches({
                requestId,
                request: response.request,
                grant: response.grant,
                envelope: response.envelope,
                locationMode,
                approximateRadiusM: sharePoint.approximateRadiusM,
              })
            ) {
              const revoked = await revokeLocationGrantOrQueue({
                userId,
                vaultOwnerToken,
                grantId: response.grant.id,
              });
              throw new Error(
                revoked
                  ? "The server did not atomically preserve the location approval. Nothing was shared."
                  : LOCATION_REVOCATION_PENDING_MESSAGE,
              );
            }
            const updates = enableOneLocationAutomaticUpdates(userId);
            if (!updates.allowed) {
              const revoked = await revokeLocationGrantOrQueue({
                userId,
                vaultOwnerToken,
                grantId: response.grant.id,
              });
              throw new Error(
                revoked
                  ? "Location was paused before automatic updates could start. Resume it and approve again."
                  : LOCATION_REVOCATION_PENDING_MESSAGE,
              );
            }
            return locationMode === "approximate"
              ? "Request approved with area updates."
              : "Request approved with a live location.";
          })();

          toast.promise(promise, {
            id: actionKey,
            loading: "Approving location request...",
            success: (message) => `✅ ${message}`,
            error: (error) =>
              `❌ ${actionError(error, "Could not approve request.")}`,
            duration: 3000,
          });

          try {
            await promise;
            emitComplete({ action: "approve", requestId });
          } catch (error) {
            console.error("[OneLocationConsent] approve failed:", error);
            throw error;
          }
        },
      );
    },
    [emitComplete, requireToken, runWithLock, userId],
  );

  /** Deny a One Location access request. Mirrors `handleDeny` in the page. */
  const handleDeny = useCallback(
    (entry: LocationConsentActionEntry): Promise<void> => {
      const ref = parseLocationConsentEntry(entry);
      const requestId = ref.requestId;
      if (!requestId) {
        toast.error("This location request can no longer be opened here.");
        return Promise.resolve();
      }
      const actionKey = `deny:${requestId}`;
      return runWithLock(
        { key: actionKey, kind: "deny", requestId },
        async () => {
          const vaultOwnerToken = requireToken();
          if (!vaultOwnerToken) return;

          const promise = (async () => {
            await OneLocationService.denyRequest({
              vaultOwnerToken,
              requestId,
            });
            return "Request denied.";
          })();

          toast.promise(promise, {
            id: actionKey,
            loading: "Denying location request...",
            success: (message) => `❌ ${message}`,
            error: (error) =>
              `❌ ${actionError(error, "Could not deny request.")}`,
            duration: 3000,
          });

          try {
            await promise;
            emitComplete({ action: "deny", requestId });
          } catch (error) {
            console.error("[OneLocationConsent] deny failed:", error);
            throw error;
          }
        },
      );
    },
    [emitComplete, requireToken, runWithLock],
  );

  /**
   * Revoke active One Location access. Routes by the underlying record kind:
   * share grants, public links, and circle invites each have a dedicated
   * endpoint. Mirrors the revoke handlers in the One Location page.
   */
  const handleRevoke = useCallback(
    (entry: LocationConsentActionEntry): Promise<void> => {
      const ref: LocationConsentEntryRef = parseLocationConsentEntry(entry);
      const scope = String(entry.scope || "").trim();
      const actionKey = `revoke:${ref.kind}:${ref.id || scope}`;
      return runWithLock(
        { key: actionKey, kind: "revoke", scope: scope || ref.id || undefined },
        async () => {
          if (!userId) {
            toast.error("Sign in again before changing location sharing.");
            return;
          }
          const vaultOwnerToken = requireToken();
          if (!vaultOwnerToken) return;
          if (!ref.id) {
            toast.error("This location grant can no longer be revoked here.");
            return;
          }

          const promise = (async () => {
            if (ref.kind === "share_grant") {
              const revoked = await revokeLocationGrantOrQueue({
                userId,
                vaultOwnerToken,
                grantId: ref.id,
              });
              if (!revoked) {
                throw new Error(LOCATION_REVOCATION_PENDING_MESSAGE);
              }
              return "Location access revoked.";
            }
            if (ref.kind === "public_invite") {
              const revoked = await revokePublicInviteOrQueue({
                userId,
                vaultOwnerToken,
                inviteId: ref.id,
              });
              if (!revoked) {
                throw new Error(LOCATION_REVOCATION_PENDING_MESSAGE);
              }
              return "Public location link revoked.";
            }
            if (ref.kind === "circle_invite") {
              await OneLocationService.revokeCircleInvite({
                vaultOwnerToken,
                inviteId: ref.id,
              });
              return "Invite to One link revoked.";
            }
            throw new Error("This location item cannot be revoked here.");
          })();

          toast.promise(promise, {
            id: actionKey,
            loading: "Revoking location access...",
            success: (message) => `🔒 ${message}`,
            error: (error) =>
              `❌ ${actionError(error, "Could not revoke access.")}`,
            duration: 3000,
          });

          try {
            await promise;
            emitComplete({ action: "revoke", scope: scope || undefined });
          } catch (error) {
            console.error("[OneLocationConsent] revoke failed:", error);
            throw error;
          }
        },
      );
    },
    [emitComplete, requireToken, runWithLock, userId],
  );

  return {
    handleApprove,
    handleDeny,
    handleRevoke,
    activeAction,
    activeActions,
    isRequestBusy,
    isScopeBusy,
  };
}
