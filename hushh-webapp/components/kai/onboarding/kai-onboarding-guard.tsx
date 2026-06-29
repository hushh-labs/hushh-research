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
import { ROUTES, isOneSetupWizardRoute } from "@/lib/navigation/routes";
import { getKaiChromeState } from "@/lib/navigation/kai-chrome-state";
import { getSessionItem, setSessionItem } from "@/lib/utils/session-storage";
import { useNativeTestConfig } from "@/lib/testing/native-test";

const KAI_ONBOARDING_COMPLETION_SESSION_PREFIX = "hushh_setup_complete";

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

/**
 * OneOnboardingGuard: the hard gate for the One onboarding surface.
 *
 * Mounted on `/one/*` (and the legacy `/kai/*`), it ensures a user who has not
 * resolved the root setup gate cannot reach any One/Kai surface other than
 * the setup flow. Incomplete users are redirected to the canonical
 * `/one/setup` hub; resolved users who land on the investor-preferences WIZARD
 * (`/one/setup/kai`) are bounced home. The `/one/setup` hub itself stays
 * browsable after setup, so resolved users are NOT bounced off it.
 */
export function OneOnboardingGuard({ children }: { children: React.ReactNode }) {
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
    // Allow-through: any setup surface (the /one/setup hub OR the
    // /one/setup/kai wizard) so incomplete users are not redirect-looped.
    const onOnboardingRoute = chromeState.isOnboardingRoute;
    // Resolved-bounce only off the WIZARD, never off the browsable setup hub.
    const onOnboardingWizardRoute = isOneSetupWizardRoute(pathname);
    const preserveOnboardingAuditRoute =
      nativeTestConfig.enabled &&
      nativeTestConfig.expectedRoute === ROUTES.ONE_SETUP_KAI;
    // Intentional re-entry: a resolved user who deliberately reopens the
    // investor-preferences wizard (e.g. tapping the Finance tile from the setup
    // hub, which forwards with a `from` param, or an explicit `edit=1`) must NOT
    // be bounced home. Only the *automatic* post-completion bounce is suppressed
    // here; first-run gating is unchanged.
    const wizardReentryRequested = (() => {
      if (typeof window === "undefined") return false;
      const params = new URLSearchParams(window.location.search);
      return params.has("from") || params.get("edit") === "1";
    })();
    const suppressWizardBounce =
      preserveOnboardingAuditRoute || wizardReentryRequested;

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

          let onboardingIncomplete = !PreVaultUserStateService.isSetupResolved(remoteState);
          if (onboardingIncomplete) {
            const remoteUnset =
              remoteState.setupCompleted === null &&
              remoteState.setupSkipped === null &&
              remoteState.setupCompletedAt === null;
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
                    setupCompleted: true,
                    setupSkipped: pending.skipped,
                    setupCompletedAt: completedAtMs,
                  });
                  onboardingIncomplete = false;
                } catch (bridgeError) {
                  console.warn(
                    "[OneOnboardingGuard] Failed local->remote pre-vault bridge:",
                    bridgeError
                  );
                }
              }
            }
          }
          setOnboardingRequiredCookie(onboardingIncomplete);
          writeOnboardingCompletionHint(user.uid, !onboardingIncomplete);

          if (onboardingIncomplete && !onOnboardingRoute) {
            router.replace(ROUTES.ONE_SETUP);
            return;
          }

          if (!onboardingIncomplete && onOnboardingWizardRoute) {
            if (!suppressWizardBounce) {
              router.replace(ROUTES.ONE_HOME);
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

          const onboardingResolved = PreVaultUserStateService.isSetupResolved(remoteState);
          const onboardingExplicitlyIncomplete =
            remoteState.setupCompleted === false && !onboardingResolved;

          setOnboardingRequiredCookie(onboardingExplicitlyIncomplete);
          writeOnboardingCompletionHint(user.uid, onboardingResolved);

          if (!onOnboardingRoute && onboardingExplicitlyIncomplete) {
            router.replace(ROUTES.ONE_SETUP);
            return;
          }
          if (onboardingResolved && onOnboardingWizardRoute) {
            if (!suppressWizardBounce) {
              router.replace(ROUTES.ONE_HOME);
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
                "[OneOnboardingGuard] Deferred onboarding sync failed, retrying later:",
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
          if (!PreVaultUserStateService.isSetupResolved(remoteState)) {
            void PreVaultUserStateService.syncKaiSetupState({
              userId: user.uid,
              completed: true,
              skipped: completion.skippedPreferences,
              completedAt: completion.completedAt,
            }).catch((syncError) => {
              console.warn(
                "[OneOnboardingGuard] Failed vault->remote onboarding bridge:",
                syncError
              );
            });
          }
        }
        setOnboardingRequiredCookie(onboardingIncomplete);
        writeOnboardingCompletionHint(user.uid, !onboardingIncomplete);

        if (onboardingIncomplete && !onOnboardingRoute) {
          router.replace(ROUTES.ONE_SETUP);
          return;
        }

        if (!onboardingIncomplete && chromeState.onboardingFlowActive) {
          // Cookie can remain set after completed onboarding/import and cause
          // repeated redirects back to /kai/import for returning users.
          setOnboardingFlowActiveCookie(false);
        }

        if (!onboardingIncomplete && onOnboardingWizardRoute) {
          if (!suppressWizardBounce) {
            router.replace(ROUTES.ONE_HOME);
            return;
          }
        }
      } catch (error) {
        console.warn("[OneOnboardingGuard] Failed to check onboarding state:", error);
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
    // Depend on `user?.uid` (stable identity) rather than the whole `user`
    // object: Firebase mints a new User reference on every token refresh, which
    // would otherwise re-run this entire gate (and its network reads) needlessly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    authLoading,
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

/**
 * @deprecated Use {@link OneOnboardingGuard}. Retained so the legacy
 * `/kai` layout keeps compiling during the route consolidation.
 */
export const KaiOnboardingGuard = OneOnboardingGuard;
