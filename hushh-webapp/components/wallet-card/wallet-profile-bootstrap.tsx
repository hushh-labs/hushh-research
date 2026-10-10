"use client";

import { useEffect, useRef } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useVault } from "@/lib/vault/vault-context";
import { WalletCardService } from "@/lib/services/wallet-card-service";
import { shouldSkipReviewerBackgroundWritesForAutomation } from "@/lib/testing/native-test";
import { buildSmartDefaultDraft, draftToPayload } from "./wallet-card-fields";

const RETRY_DELAYS = [1_000, 5_000, 20_000] as const;

/**
 * Provision once the existing signed-in session has owner authority. The same
 * insert-only endpoint serves new and returning accounts, and never changes
 * an existing profile's fields, pause, or removal. No route visit is required.
 */
export function WalletProfileBootstrap() {
  const { user, loading, phoneNumber } = useAuth();
  const { isVaultUnlocked, vaultOwnerToken } = useVault();
  const completedOwner = useRef<string | null>(null);
  const userId = user?.uid ?? null;
  const displayName = user?.displayName ?? null;
  const email = user?.email ?? null;
  const phone = phoneNumber ?? user?.phoneNumber ?? null;
  const avatarUrl = user?.photoURL ?? null;

  useEffect(() => {
    if (!userId) completedOwner.current = null;
    if (shouldSkipReviewerBackgroundWritesForAutomation() || loading || !userId || !isVaultUnlocked || !vaultOwnerToken || completedOwner.current === userId) return;
    let cancelled = false;
    let running = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ensure = async () => {
      if (shouldSkipReviewerBackgroundWritesForAutomation() || cancelled || running || completedOwner.current === userId || document.visibilityState === "hidden") return;
      running = true;
      try {
        await WalletCardService.ensureCard({
          userId,
          vaultOwnerToken,
          payload: draftToPayload(buildSmartDefaultDraft({ displayName, email, phoneNumber: phone })),
          avatarUrl,
        });
        if (!cancelled) completedOwner.current = userId;
      } catch {
        // A background failure must not block sign-in or expose account fields.
        // The owner screen also retries when opened; reconnect/focus can recover.
        const delay = RETRY_DELAYS[attempt++];
        if (!cancelled && delay !== undefined) timer = setTimeout(() => { void ensure(); }, delay);
      } finally {
        running = false;
      }
    };
    const recover = () => { void ensure(); };
    void ensure();
    window.addEventListener("online", recover);
    window.addEventListener("focus", recover);
    document.addEventListener("visibilitychange", recover);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      window.removeEventListener("online", recover);
      window.removeEventListener("focus", recover);
      document.removeEventListener("visibilitychange", recover);
    };
  }, [loading, userId, isVaultUnlocked, vaultOwnerToken, displayName, email, phone, avatarUrl]);

  return null;
}
