"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";

import { HushhLoader } from "@/components/app-ui/hushh-loader";
import { Button } from "@/lib/morphy-ux/button";
import {
  KaiProfileService,
  resolveKaiOnboardingCompletion,
} from "@/lib/services/kai-profile-service";
import { KaiProfileSyncService } from "@/lib/services/kai-profile-sync-service";
import { PreVaultOnboardingService } from "@/lib/services/pre-vault-onboarding-service";
import { PreVaultUserStateService } from "@/lib/services/pre-vault-user-state-service";
import { VaultService } from "@/lib/services/vault-service";
import { useAuth } from "@/hooks/use-auth";
import { useVault } from "@/lib/vault/vault-context";
import {
  setOnboardingFlowActiveCookie,
  setOnboardingRequiredCookie,
} from "@/lib/services/onboarding-route-cookie";
import { ROUTES } from "@/lib/navigation/routes";
import { getKaiChromeState } from "@/lib/navigation/kai-chrome-state";
import { getSessionItem, setSessionItem } from "@/lib/utils/session-storage";
import { useNativeTestConfig } from "@/lib/testing/native-test";

const KAI_ONBOARDING_COMPLETION_SESSION_PREFIX = "kai_onboarding_complete";

function onboardingCompletionSessionKey(userId: string): string {
  return `${KAI_ONBOARDING_COMPLETION_SESSION_PREFIX}:${userId}`;
}

function readOnboardingCompletionHint(userId: string): boolean | null {
  const raw = getSessionItem(onboardingCompletionSessionKey(userId));
  if (raw === "1") return true;
  if (raw === "0") return false;
  return null;
}

function writeOnboardingCompletionHint(userId: string, completed: boolean): void {
  setSessionItem(onboardingCompletionSessionKey(userId), completed ? "1" : "0");
}

export function KaiOnboardingGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { user, loading: authLoading } = useAuth();
  const { vaultKey, vaultOwnerToken, isVaultUnlocked } = useVault();
  const nativeTestConfig = useNativeTestConfig();

  const [checking, setChecking] = useState(true);
  const [guardError, setGuardError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const chromeState = getKaiChromeState(pathname);
    const onOnboardingRoute = chromeState.isOnboardingRoute;
    const preserveOnboardingAuditRoute =
      nativeTestConfig.enabled &&
      nativeTestConfig.expectedRoute === ROUTES.KAI_ONBOARDING;

    async function run() {
      if (authLoading) return;

      // VaultLockGuard handles unauthenticated states.
      if (!user) {
        setChecking(false);
        return;
      }

      try {
        setGuardError(null);
        const cachedCompletionHint = readOnboardingCompletionHint(user.uid);
        const unlockedOnStandardKaiRoute = isVaultUnlocked && !onOnboardingRoute;
        if (unlockedOnStandardKaiRoute && cachedCompletionHint !== false) {
          setChecking(false);
        }
        if (unlockedOnStandardKaiRoute && cachedCompletionHint === true) {
          setOnboardingRequiredCookie(false);
          if (chromeState.onboardingFlowActive) {
            setOnboardingFlowActiveCookie(false);
          }
          return;
        }

        const hasVault = isVaultUnlocked ? true : await VaultService.checkVault(user.uid);
        if (cancelled) return;

        if (!hasVault) {
          const remoteState = await PreVaultUserStateService.bootstrapState(user.uid);
          if (cancelled) return;

          let onboardingIncomplete = !PreVaultUserStateService.isOnboardingResolved(remoteState);
          if (onboardingIncomplete) {
            const remoteUnset =
              remoteState.preOnboardingCompleted === null &&
              remoteState.preOnboardingSkipped === null &&
              remoteState.preOnboardingCompletedAt === null;
            if (remoteUnset) {
              const pending = await PreVaultOnboardingService.load(user.uid).catch(
                () => null
              );
              if (cancelled) return;
              if (pending?.completed) {
                const completedAtMs =
                  pending.completed_at && !Number.isNaN(Date.parse(pending.completed_at))
                    ? Date.parse(pending.completed_at)
                    : Date.now();
                try {
                  await PreVaultUserStateService.updatePreVaultState(user.uid, {
                    preOnboardingCompleted: true,
                    preOnboardingSkipped: pending.skipped,
                    preOnboardingCompletedAt: completedAtMs,
                  });
                  onboardingIncomplete = false;
                } catch (bridgeError) {
                  console.warn(
                    "[KaiOnboardingGuard] Failed local->remote pre-vault bridge:",
                    bridgeError
                  );
                }
              }
            }
          }
          setOnboardingRequiredCookie(onboardingIncomplete);
          writeOnboardingCompletionHint(user.uid, !onboardingIncomplete);

          if (onboardingIncomplete && !onOnboardingRoute) {
            router.replace(ROUTES.KAI_ONBOARDING);
            return;
          }

          if (!onboardingIncomplete && onOnboardingRoute) {
            if (!preserveOnboardingAuditRoute) {
              router.replace(ROUTES.KAI_HOME);
              return;
            }
          }

          setChecking(false);
          return;
        }

        // If vault exists but is not currently unlocked, prefer the server-verifiable
        // pre-vault mirror, but do not force legacy vault users into onboarding when
        // the mirror has never been backfilled yet. Their real onboarding state will
        // be determined from the encrypted profile after unlock.
        if (!isVaultUnlocked || !vaultKey || !vaultOwnerToken) {
          const remoteState = await PreVaultUserStateService.bootstrapState(user.uid).catch(
            () => null
          );
          if (cancelled) return;
          if (!remoteState) {
            setChecking(false);
            return;
          }

          const onboardingResolved = PreVaultUserStateService.isOnboardingResolved(remoteState);
          const onboardingExplicitlyIncomplete =
            remoteState.preOnboardingCompleted === false && !onboardingResolved;

          setOnboardingRequiredCookie(onboardingExplicitlyIncomplete);
          writeOnboardingCompletionHint(user.uid, onboardingResolved);

          if (!onOnboardingRoute && onboardingExplicitlyIncomplete) {
            router.replace(ROUTES.KAI_ONBOARDING);
            return;
          }
          if (onboardingResolved && onOnboardingRoute) {
            if (!preserveOnboardingAuditRoute) {
              router.replace(ROUTES.KAI_HOME);
              return;
            }
          }
          setChecking(false);
          return;
        }

        const profile = await KaiProfileService.getProfile({
          userId: user.uid,
          vaultKey,
          vaultOwnerToken,
        });

        if (cancelled) return;

        const completion = resolveKaiOnboardingCompletion(profile);
        let onboardingIncomplete = !completion.completed;
        if (onboardingIncomplete) {
          const pending = await PreVaultOnboardingService.load(user.uid).catch(() => null);
          if (cancelled) return;

          // If pre-vault onboarding was already completed locally (skip or answered),
          // do not bounce users back into onboarding while vault sync catches up.
          if (pending?.completed) {
            onboardingIncomplete = false;

            void KaiProfileSyncService.syncPendingToVault({
              userId: user.uid,
              vaultKey,
              vaultOwnerToken,
            }).catch((syncError) => {
              console.warn(
                "[KaiOnboardingGuard] Deferred onboarding sync failed, retrying later:",
                syncError
              );
            });
          }
        }

        if (!onboardingIncomplete) {
          const remoteState = await PreVaultUserStateService.bootstrapState(user.uid).catch(
            () => null
          );
          if (cancelled) return;
          if (!PreVaultUserStateService.isOnboardingResolved(remoteState)) {
            void PreVaultUserStateService.syncKaiOnboardingState({
              userId: user.uid,
              completed: true,
              skipped: completion.skippedPreferences,
              completedAt: completion.completedAt,
            }).catch((syncError) => {
              console.warn(
                "[KaiOnboardingGuard] Failed vault->remote onboarding bridge:",
                syncError
              );
            });
          }
        }
        setOnboardingRequiredCookie(onboardingIncomplete);
        writeOnboardingCompletionHint(user.uid, !onboardingIncomplete);

        if (onboardingIncomplete && !onOnboardingRoute) {
          router.replace(ROUTES.KAI_ONBOARDING);
          return;
        }

        if (!onboardingIncomplete && chromeState.onboardingFlowActive) {
          // Cookie can remain set after completed onboarding/import and cause
          // repeated redirects back to /kai/import for returning users.
          setOnboardingFlowActiveCookie(false);
        }

        if (!onboardingIncomplete && onOnboardingRoute) {
          if (!preserveOnboardingAuditRoute) {
            router.replace(ROUTES.KAI_HOME);
            return;
          }
        }
      } catch (error) {
        console.warn("[KaiOnboardingGuard] Failed to check onboarding state:", error);
        if (!cancelled) {
          setGuardError("Unable to load onboarding state. Please retry.");
        }
      } finally {
        if (!cancelled) setChecking(false);
      }
    }

    void run();

    return () => {
      cancelled = true;
    };
  }, [
    authLoading,
    user,
    user?.uid,
    isVaultUnlocked,
    vaultKey,
    vaultOwnerToken,
    pathname,
    nativeTestConfig.enabled,
    nativeTestConfig.expectedRoute,
    router,
    retryNonce,
  ]);

  if (checking) {
    return <HushhLoader label="Loading Kai..." />;
  }

  if (guardError) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center px-4">
        <div className="w-full max-w-sm rounded-xl border border-border bg-card/70 p-4 text-center">
          <p className="text-sm text-foreground">{guardError}</p>
          <Button
            size="sm"
            className="mt-3"
            onClick={() => {
              setChecking(true);
              setRetryNonce((value) => value + 1);
            }}
          >
            Retry
          </Button>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
