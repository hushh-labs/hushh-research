"use client";

/**
 * Runs the device half of a voice-armed account reset or deletion, from any
 * screen. Mounted once inside VaultProvider so an already-unlocked vault's
 * owner token is used instead of asking for an unlock the person just did.
 *
 * The decisions live in lib/one-voice/account-lifecycle-step.ts (pure,
 * tested); this only binds the real flows: the same auth resolution and
 * deletion the Profile screen uses, the same reset route, the same cleanup.
 */

import { useRouter } from "next/navigation";
import { useRef } from "react";

import { useAuth } from "@/hooks/use-auth";
import { buildLoginRouteWithAuthSessionNotice } from "@/lib/auth/session-invalidation";
import { CacheSyncService } from "@/lib/cache/cache-sync-service";
import {
  executeVerifiedAccountDeletion,
  resolveDeleteAccountAuth,
  revokeVaultBanksBeforeErasure,
} from "@/lib/flows/delete-account";
import { ROUTES } from "@/lib/navigation/routes";
import {
  ACCOUNT_LIFECYCLE_STEP_KIND,
  runAccountLifecycleStep,
} from "@/lib/one-voice/account-lifecycle-step";
import { useVoiceToolEffects } from "@/lib/one-voice/session-store";
import { AccountService } from "@/lib/services/account-service";
import {
  setOnboardingFlowActiveCookie,
  setOnboardingRequiredCookie,
} from "@/lib/services/onboarding-route-cookie";
import { UserLocalStateService } from "@/lib/services/user-local-state-service";
import { useVault } from "@/lib/vault/vault-context";

export function AccountLifecycleStepBridge() {
  const { user, signOut } = useAuth();
  const { vaultKey, vaultOwnerToken } = useVault();
  const router = useRouter();
  const handledRef = useRef<Set<string>>(new Set());

  useVoiceToolEffects({
    onClientStep: (step, report) => {
      if (step.kind !== ACCOUNT_LIFECYCLE_STEP_KIND) return;
      if (handledRef.current.has(step.stepId)) return;
      handledRef.current.add(step.stepId);

      const sessionUser = user;
      void runAccountLifecycleStep(step, {
        currentUid: sessionUser?.uid ?? null,
        existingVaultOwnerToken: vaultOwnerToken ?? null,
        resolveAuth: resolveDeleteAccountAuth,
        resetAccount: async (token) => {
          if (!sessionUser) throw new Error("Signed out before reset could run.");
          await revokeVaultBanksBeforeErasure({
            userId: sessionUser.uid,
            vaultKey,
            vaultOwnerToken: token,
          });
          return AccountService.resetAccount(token);
        },
        afterReset: async (uid) => {
          CacheSyncService.onAccountDeleted(uid);
          await UserLocalStateService.clearForUser(uid);
          setOnboardingRequiredCookie(true);
          setOnboardingFlowActiveCookie(true);
          router.replace(ROUTES.ONE_SETUP);
        },
        executeDeletion: ({ userId, vaultOwnerToken: token }) => {
          if (!sessionUser) throw new Error("Signed out before deletion could run.");
          return executeVerifiedAccountDeletion({
            userId,
            vaultOwnerToken: token,
            sessionUser,
            vaultKey,
          });
        },
        afterDelete: async (uid) => {
          await signOut({
            redirectTo: buildLoginRouteWithAuthSessionNotice("account_deleted"),
            expectedUserId: uid,
            skipFcmCleanup: true,
          });
        },
      }).then((result) => report(result.status, result.payload));
    },
  });

  return null;
}
