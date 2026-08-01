"use client";

import { useEffect } from "react";

import { useAuth } from "@/hooks/use-auth";
import {
  ONE_LOCATION_PENDING_REVOCATIONS_CHANGED,
  pendingLocationRevocationGrantIds,
  pendingLocationRevocationStorageKey,
  pendingPublicInviteRevocationIds,
  pendingPublicInviteRevocationStorageKey,
  retryPendingLocationRevocations,
  retryPendingPublicInviteRevocations,
} from "@/lib/one-location/location-revocation-queue";
import { useVault } from "@/lib/vault/vault-context";

const INITIAL_RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 60_000;

/**
 * App-level retry worker for failed One Location revocations.
 *
 * The vault token remains memory-only. Work therefore pauses while the vault
 * is locked and resumes after the same user unlocks again. Per-ID queue records
 * make concurrent tabs safe; this worker is single-flight within each tab.
 */
export function LocationRevocationRuntime(): null {
  const { user } = useAuth();
  const { getVaultOwnerToken, vaultOwnerToken } = useVault();

  useEffect(() => {
    const userId = user?.uid;
    if (!userId || !vaultOwnerToken || typeof window === "undefined") return;

    let cancelled = false;
    let inFlight = false;
    let timer: number | null = null;
    let retryDelayMs = INITIAL_RETRY_DELAY_MS;

    const clearTimer = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
    };
    const hasPending = () =>
      pendingLocationRevocationGrantIds(userId).size > 0 ||
      pendingPublicInviteRevocationIds(userId).size > 0;

    let run: () => Promise<void>;
    const schedule = (delayMs: number) => {
      if (cancelled) return;
      clearTimer();
      timer = window.setTimeout(() => void run(), delayMs);
    };

    run = async () => {
      clearTimer();
      if (cancelled || inFlight || !hasPending()) return;
      if (typeof navigator !== "undefined" && navigator.onLine === false) {
        return;
      }
      const token = getVaultOwnerToken();
      if (!token) return;

      inFlight = true;
      try {
        const [grantResult, inviteResult] = await Promise.all([
          retryPendingLocationRevocations({
            userId,
            vaultOwnerToken: token,
          }),
          retryPendingPublicInviteRevocations({
            userId,
            vaultOwnerToken: token,
          }),
        ]);
        const pendingCount =
          grantResult.pendingGrantIds.length +
          inviteResult.pendingInviteIds.length;
        if (pendingCount > 0) {
          schedule(retryDelayMs);
          retryDelayMs = Math.min(
            retryDelayMs * 2,
            MAX_RETRY_DELAY_MS,
          );
        } else {
          retryDelayMs = INITIAL_RETRY_DELAY_MS;
        }
      } catch {
        schedule(retryDelayMs);
        retryDelayMs = Math.min(retryDelayMs * 2, MAX_RETRY_DELAY_MS);
      } finally {
        inFlight = false;
        // A queue event can arrive while this tab already has a retry in
        // flight. Its zero-delay run then exits at the single-flight guard.
        // Recheck after releasing the guard so a newly queued revoke is not
        // stranded until the next focus/online/storage event. Preserve any
        // existing backoff timer when the current retry itself failed.
        if (!cancelled && hasPending() && timer === null) schedule(0);
      }
    };

    const trigger = (event?: Event) => {
      const changedUserId = (
        event as CustomEvent<{ userId?: string }> | undefined
      )?.detail?.userId;
      if (changedUserId && changedUserId !== userId) return;
      retryDelayMs = INITIAL_RETRY_DELAY_MS;
      schedule(0);
    };
    const onStorage = (event: StorageEvent) => {
      if (
        event.key?.startsWith(pendingLocationRevocationStorageKey(userId)) ||
        event.key?.startsWith(pendingPublicInviteRevocationStorageKey(userId))
      ) {
        trigger();
      }
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") trigger();
    };

    window.addEventListener(
      ONE_LOCATION_PENDING_REVOCATIONS_CHANGED,
      trigger,
    );
    window.addEventListener("storage", onStorage);
    window.addEventListener("online", trigger);
    window.addEventListener("focus", trigger);
    document.addEventListener("visibilitychange", onVisible);
    trigger();

    return () => {
      cancelled = true;
      clearTimer();
      window.removeEventListener(
        ONE_LOCATION_PENDING_REVOCATIONS_CHANGED,
        trigger,
      );
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("online", trigger);
      window.removeEventListener("focus", trigger);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [getVaultOwnerToken, user?.uid, vaultOwnerToken]);

  return null;
}
