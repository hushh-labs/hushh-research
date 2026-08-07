"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";

import { useAuth } from "@/hooks/use-auth";
import { PostUnlockSyncService } from "@/lib/services/post-unlock-sync-service";
import { PreVaultSensitiveDraftService } from "@/lib/services/pre-vault-sensitive-draft-service";
import { useVault } from "@/lib/vault/vault-context";

const POST_UNLOCK_RETRY_DELAYS_MS = [250, 1_000, 3_000] as const;

/**
 * Flushes memory-only setup drafts and ordinary onboarding answers through
 * their existing encrypted stores after vault creation/unlock succeeds.
 */
export function PostAuthOnboardingSyncBridge() {
  const { user, loading } = useAuth();
  const { isVaultUnlocked, vaultKey, vaultOwnerToken } = useVault();
  const pathname = usePathname();
  const userId = user?.uid ?? null;
  const activeSignatureRef = useRef<string | null>(null);
  const lastSyncedSignatureRef = useRef<string | null>(null);
  const pendingRef = useRef<{
    signature: string;
    params: { userId: string; vaultKey: string; vaultOwnerToken: string };
    attempt: number;
  } | null>(null);
  const mountedRef = useRef(true);
  const eligibleSignatureRef = useRef<string | null>(null);
  const retryTimerRef = useRef<number | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      pendingRef.current = null;
      eligibleSignatureRef.current = null;
      if (retryTimerRef.current !== null) {
        window.clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const cancelScheduledRetry = () => {
      if (retryTimerRef.current === null) return;
      window.clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    };

    if (
      loading ||
      !userId ||
      !isVaultUnlocked ||
      !vaultKey ||
      !vaultOwnerToken
    ) {
      eligibleSignatureRef.current = null;
      pendingRef.current = null;
      cancelScheduledRetry();
      return;
    }

    // Finish setup owns the first durable commit. Running this background
    // bridge while the setup hub is finalizing would create duplicate PKM
    // revisions and could clear a volatile draft before the hub can report a
    // retryable failure.
    if (pathname.startsWith("/one/setup")) {
      eligibleSignatureRef.current = null;
      pendingRef.current = null;
      cancelScheduledRetry();
      return;
    }

    const signature = `${userId}:${vaultOwnerToken}:${vaultKey}`;
    if (eligibleSignatureRef.current !== signature) {
      cancelScheduledRetry();
    }
    eligibleSignatureRef.current = signature;
    if (lastSyncedSignatureRef.current === signature) {
      return;
    }
    if (retryTimerRef.current !== null) {
      return;
    }
    if (activeSignatureRef.current === signature) {
      return;
    }

    const params = { userId, vaultKey, vaultOwnerToken };
    pendingRef.current = { signature, params, attempt: 0 };

    const drain = () => {
      if (!mountedRef.current || activeSignatureRef.current) return;
      const next = pendingRef.current;
      pendingRef.current = null;
      if (
        !next ||
        lastSyncedSignatureRef.current === next.signature ||
        eligibleSignatureRef.current !== next.signature
      ) {
        return;
      }

      activeSignatureRef.current = next.signature;
      void (async (): Promise<boolean> => {
        await PreVaultSensitiveDraftService.finalizeForVault(next.params);
        if (
          !mountedRef.current ||
          eligibleSignatureRef.current !== next.signature
        ) {
          return false;
        }
        await PostUnlockSyncService.run(next.params);
        return (
          mountedRef.current && eligibleSignatureRef.current === next.signature
        );
      })()
        .then((completed) => {
          if (completed) {
            lastSyncedSignatureRef.current = next.signature;
          }
        })
        .catch((error) => {
          const retryDelay = POST_UNLOCK_RETRY_DELAYS_MS[next.attempt];
          console.warn(
            retryDelay === undefined
              ? "[PostAuthOnboardingSyncBridge] Post-unlock sync failed after bounded retries:"
              : "[PostAuthOnboardingSyncBridge] Post-unlock sync failed, retrying:",
            error,
          );
          if (
            retryDelay !== undefined &&
            mountedRef.current &&
            eligibleSignatureRef.current === next.signature
          ) {
            retryTimerRef.current = window.setTimeout(() => {
              retryTimerRef.current = null;
              if (
                !mountedRef.current ||
                eligibleSignatureRef.current !== next.signature ||
                lastSyncedSignatureRef.current === next.signature
              ) {
                return;
              }
              pendingRef.current = {
                ...next,
                attempt: next.attempt + 1,
              };
              drain();
            }, retryDelay);
          }
        })
        .finally(() => {
          if (activeSignatureRef.current === next.signature) {
            activeSignatureRef.current = null;
          }
          if (pendingRef.current) drain();
        });
    };

    drain();
  }, [isVaultUnlocked, loading, pathname, userId, vaultKey, vaultOwnerToken]);

  return null;
}
