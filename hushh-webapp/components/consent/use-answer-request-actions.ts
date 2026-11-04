"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { getAuthSessionGeneration } from "@/lib/auth/session-owner";
import { CacheSyncService } from "@/lib/cache/cache-sync-service";
import { dispatchConsentStateChanged } from "@/lib/consent/consent-events";
import { marketplaceRecipientKeyId } from "@/lib/one-marketplace/encryption";
import { bootstrapCurrentUserMarketplaceRecipientKey } from "@/lib/one-marketplace/key-bootstrap";
import { AnswerRequestService, type AnswerRequestState } from "@/lib/services/answer-request-service";
import { AuthService } from "@/lib/services/auth-service";
import { useVault } from "@/lib/vault/vault-context";
import { isVaultSessionEpochCurrent, snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";

type Action = (token: string, epoch: number, isCurrent: () => boolean) => Promise<unknown>;
type Run = (action: Action) => Promise<void>;

/** One synchronous action lease, retired on unmount, participant, auth or vault change. */
export function useAnswerRequestAction({ userId, requestId, load, setBusy, setError }: {
  userId: string | null;
  requestId: string;
  load: () => Promise<void>;
  setBusy: (busy: boolean) => void;
  setError: (error: string | null) => void;
}): Run {
  const mounted = useRef(true);
  const operation = useRef<symbol | null>(null);
  const identity = useRef({ userId, requestId });
  identity.current = { userId, requestId };
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; operation.current = null; };
  }, []);
  useEffect(() => { operation.current = null; }, [userId, requestId]);
  return useCallback(async (action: Action) => {
    if (operation.current || !mounted.current) return;
    const lease = Symbol();
    operation.current = lease;
    const epoch = snapshotVaultSessionEpoch();
    const authGeneration = getAuthSessionGeneration();
    const current = () => mounted.current && operation.current === lease &&
      authGeneration === getAuthSessionGeneration() && identity.current.userId === userId &&
      identity.current.requestId === requestId && isVaultSessionEpochCurrent(epoch);
    setBusy(true);
    setError(null);
    try {
      const token = await AuthService.getIdToken();
      if (!token) throw new Error("Sign in to continue.");
      if (!current()) throw new Error("Session changed. Open this request again.");
      await action(token, epoch, current);
      if (!current()) return;
      if (userId) CacheSyncService.onConsentMutated(userId);
      dispatchConsentStateChanged({ userId, requestId: `answer_request:${requestId}` });
      await load();
    } catch (cause) {
      if (current()) setError(cause instanceof Error ? cause.message : "That could not be completed.");
    } finally {
      if (operation.current === lease) {
        operation.current = null;
        if (mounted.current) setBusy(false);
      }
    }
  }, [load, requestId, userId, setBusy, setError]);
}

/** Device custody is inspected without generating a replacement merely to authorize Pay. */
export function useAnswerRequestReceiving({ state, requestId, run, coverageVerified, onUnlock }: {
  state: AnswerRequestState | null;
  requestId: string;
  run: Run;
  coverageVerified: boolean;
  onUnlock: () => void;
}) {
  const { userId } = useAuth();
  const { isVaultUnlocked, vaultOwnerToken } = useVault();
  const [deviceKeyReady, setDeviceKeyReady] = useState(false);
  const stagedKeyId = state?.deliveryRecipientKeyId;
  const requester = state?.role === "requester";
  useEffect(() => {
    setDeviceKeyReady(false);
    if (!userId || !isVaultUnlocked || !requester || !stagedKeyId) return;
    let retired = false;
    const epoch = snapshotVaultSessionEpoch();
    void marketplaceRecipientKeyId(userId).then(keyId => {
      if (!retired && isVaultSessionEpochCurrent(epoch)) setDeviceKeyReady(keyId === stagedKeyId);
    }).catch(() => { /* Unavailable local custody cannot authorize payment. */ });
    return () => { retired = true; };
  }, [stagedKeyId, requester, userId, isVaultUnlocked, vaultOwnerToken]);

  const openCheckout = () => run(async (token, _epoch, current) => {
    if (!coverageVerified) throw new Error("Answer coverage could not be verified. Refresh this question before paying.");
    if (!userId || !isVaultUnlocked) throw new Error("Unlock your vault before paying for this answer.");
    const fresh = await AnswerRequestService.state(token, requestId);
    const keyId = await marketplaceRecipientKeyId(userId);
    if (!current()) return;
    if (!fresh.deliveryRecipientKeyId || fresh.deliveryRecipientKeyId !== keyId || fresh.requesterKeyReady === false)
      throw new Error("This device cannot receive the prepared answer. Open this question on the device that sent it before paying.");
    const url = await AnswerRequestService.checkout(token, requestId);
    if (current()) window.location.assign(url);
  });
  const setupReceiving = () => {
    if (!isVaultUnlocked || !vaultOwnerToken) { onUnlock(); return; }
    void run(async (_token, _epoch, current) => {
      if (!userId || state?.role !== "requester") throw new Error("Open your own request to enable receiving.");
      if (stagedKeyId && state.deliveryRecipientKeyActive !== false && await marketplaceRecipientKeyId(userId) !== stagedKeyId)
        throw new Error("Use the device that sent this request. Creating a new key cannot unlock an already prepared answer.");
      await bootstrapCurrentUserMarketplaceRecipientKey({ userId, vaultOwnerToken, isCurrent: current });
    });
  };
  return { deviceKeyReady, openCheckout, setupReceiving };
}
