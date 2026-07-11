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
import {
  readOneSetupCompletionHint,
  writeOneSetupCompletionHint,
} from "@/lib/services/one-setup-exit-service";
import { isNativePlatform } from "@/lib/utils/session-storage";
import {
  ROUTES,
  buildOneSetupRoute,
  isCapabilityHandoffTarget,
  isOneSetupWizardRoute,
  normalizeInternalRouteHref,
} from "@/lib/navigation/routes";
import { getKaiChromeState } from "@/lib/navigation/kai-chrome-state";
import { useNativeTestConfig } from "@/lib/testing/native-test";

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
  const [redirectTarget, setRedirectTarget] = useState<string | null>(null);

  useEffect(() => {
    setRedirectTarget(null);
  }, [pathname]);

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
    const redirectTo = (target: string) => {
      setRedirectTarget(target);
      router.replace(target);
    };
    const setupGateRedirect = () => {
      const returnTo =
        typeof window === "undefined"
          ? pathname
          : window.location.pathname + window.location.search + window.location.hash;
      return buildOneSetupRoute({ returnTo });
    };
    // Setup-originated entry into a hard-gated capability surface: pressing
    // "Continue" on a `/one/setup/<id>` tile forwards to the real product
    // surface tagged `?from=/one/setup` (e.g. `/one/gmail?from=/one/setup`). The
    // setup flow deliberately sends an INCOMPLETE user into that one capability
    // to finish it; the master gate is resolved only on a genuine finish (hub
    // Skip/Continue), NOT by entering a capability. Allow these through instead
    // of bouncing to `/one/setup` — the redirect loop `d83ed1890` fixed, but
    // now WITHOUT its account-wide side effect of marking ALL setup complete
    // (which cleared the dashboard's "Finish setup" bar). The marker is the hub
    // PATH (not a bare "setup") so the top-bar back can also retrace to the hub.
    // Scoped to known gated handoff targets + `from === /one/setup`, so arbitrary
    // `/one/*` stays gated.
    const setupOriginatedCapabilityEntry = (() => {
      if (typeof window === "undefined") return false;
      const params = new URLSearchParams(window.location.search);
      return (
        normalizeInternalRouteHref(params.get("from")) === ROUTES.ONE_SETUP &&
        isCapabilityHandoffTarget(pathname)
      );
    })();

    async function run() {
      if (authLoading) return;

      // VaultLockGuard handles unauthenticated states.
      if (!user) {
        setChecking(false);
        return;
      }

      try {
        setGuardError(null);
        const cachedCompletionHint = readOneSetupCompletionHint(user.uid);
        // NATIVE fast-path: on iOS the async vault/bootstrap check can transiently
        // report setup "incomplete" and bounce the user back to /one/setup (dead
        // back button / trapped on setup) even immediately after they resolved it.
        // The in-session completion hint — written synchronously by
        // primeOneSetupResolved (the setup back button, Skip, and Continue) and by
        // this guard after a real check — is the authoritative "already resolved"
        // signal, and it is purged on a native cold start. So on native, trust it
        // and let the user onto standard /one/* routes without the async bounce.
        // Web behavior is unchanged (guarded by isNativePlatform()).
        if (
          isNativePlatform() &&
          !onOnboardingRoute &&
          cachedCompletionHint === true
        ) {
          setOnboardingRequiredCookie(false);
          if (chromeState.onboardingFlowActive) {
            setOnboardingFlowActiveCookie(false);
          }
          setChecking(false);
          return;
        }
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
          writeOneSetupCompletionHint(user.uid, !onboardingIncomplete);

          if (
            onboardingIncomplete &&
            !onOnboardingRoute &&
            !setupOriginatedCapabilityEntry
          ) {
            redirectTo(setupGateRedirect());
            return;
          }

          if (!onboardingIncomplete && onOnboardingWizardRoute) {
            if (!suppressWizardBounce) {
              redirectTo(ROUTES.ONE_HOME);
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
          writeOneSetupCompletionHint(user.uid, onboardingResolved);

          if (
            !onOnboardingRoute &&
            onboardingExplicitlyIncomplete &&
            !setupOriginatedCapabilityEntry
          ) {
            redirectTo(setupGateRedirect());
            return;
          }
          if (onboardingResolved && onOnboardingWizardRoute) {
            if (!suppressWizardBounce) {
              redirectTo(ROUTES.ONE_HOME);
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
        writeOneSetupCompletionHint(user.uid, !onboardingIncomplete);

        if (
          onboardingIncomplete &&
          !onOnboardingRoute &&
          !setupOriginatedCapabilityEntry
        ) {
          redirectTo(setupGateRedirect());
          return;
        }

        if (!onboardingIncomplete && chromeState.onboardingFlowActive) {
          // Cookie can remain set after completed onboarding/import and cause
          // repeated redirects back to /kai/import for returning users.
          setOnboardingFlowActiveCookie(false);
        }

        if (!onboardingIncomplete && onOnboardingWizardRoute) {
          if (!suppressWizardBounce) {
            redirectTo(ROUTES.ONE_HOME);
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

  if (redirectTarget) {
    return <HushhLoader label="Opening One..." />;
  }

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
