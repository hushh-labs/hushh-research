"use client";

import { useEffect, useLayoutEffect, useSyncExternalStore } from "react";
import { usePathname } from "next/navigation";
import { Capacitor } from "@capacitor/core";
import { preloadGoogleContactsAuth } from "@/lib/contacts/google-contacts-token";
import { useAuth } from "@/lib/firebase/auth-context";
import { useVault } from "@/lib/vault/vault-context";
import { InitialContactsOnboardingService as InitialContacts } from "@/lib/services/initial-contacts-onboarding-service";
import { PreVaultUserStateService } from "@/lib/services/pre-vault-user-state-service";

export function useInitialContacts() {
  return useSyncExternalStore(InitialContacts.subscribe, InitialContacts.getSnapshot, InitialContacts.getServerSnapshot);
}

/** Above route Suspense: accepted signup reads survive phone/setup remounts. */
export function InitialContactsBridge() {
  const { user, userId, loading, sessionVerificationRequired } = useAuth();
  const { vaultOwnerToken } = useVault();
  const pathname = usePathname();
  const state = useInitialContacts();
  useLayoutEffect(() => {
    InitialContacts.invalidateStale();
    if (sessionVerificationRequired) InitialContacts.reset();
  }, [userId, loading, sessionVerificationRequired, state.ownerId]);
  useEffect(() => {
    if (state.source === "google" && !Capacitor.isNativePlatform()) {
      void preloadGoogleContactsAuth().catch(() => undefined);
    }
  }, [state.source]);
  useEffect(() => {
    if (loading || sessionVerificationRequired) return;
    if (!user || !userId) return;
    let active = true;
    void PreVaultUserStateService.bootstrapState(userId).then((bootstrap) => {
      if (active && !InitialContacts.wasDismissed(userId)) void InitialContacts.restore(user, bootstrap).catch(() => undefined);
    }).catch(() => undefined);
    return () => { active = false; };
  }, [user, userId, loading, sessionVerificationRequired, pathname, state.ownerId]);

  useEffect(() => {
    if (!user || !userId || sessionVerificationRequired || state.ownerId !== userId) return;
    if (["reading", "waiting_for_phone"].includes(state.status)) {
      void InitialContacts.matchWhenVerified().catch(() => undefined);
    }
    const bootstrap = PreVaultUserStateService.getCachedBootstrapState(userId);
    if (vaultOwnerToken && bootstrap?.setupCompleted === true && bootstrap.initialContactsWelcomeAcknowledged === false) {
      void InitialContacts.prepareCircle(vaultOwnerToken);
    }
  }, [user, userId, pathname, sessionVerificationRequired, vaultOwnerToken, state.ownerId, state.status, state.result]);
  return null;
}
