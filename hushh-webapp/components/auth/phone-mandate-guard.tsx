"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { HushhLoader } from "@/components/app-ui/hushh-loader";
import { useAuth } from "@/lib/firebase/auth-context";
import { buildPhoneMandateRoute } from "@/lib/navigation/routes";
import { AccountIdentityService } from "@/lib/services/account-identity-service";
import { CacheService, CACHE_KEYS } from "@/lib/services/cache-service";
import {
  hasVerifiedPhoneNumber,
  isPhoneMandatePath,
  shouldBypassPhoneMandateForLocalhost,
  shouldRequirePhoneMandate,
} from "@/lib/services/phone-mandate-service";
import { PreVaultUserStateService } from "@/lib/services/pre-vault-user-state-service";
import { VaultService } from "@/lib/services/vault-service";
import { useHostname } from "@/lib/hooks/use-hostname";
import { useSessionChromeSuppression } from "@/lib/auth/use-session-chrome-suppression";
import { SessionVerificationRecovery } from "@/components/auth/session-verification-recovery";
import { shouldSkipAmbientIdentityHydrationForAutomation } from "@/lib/testing/native-test";

function resolveInitialVaultPresence(params: {
  userId: string | null | undefined;
}): boolean | null {
  if (!params.userId) return null;
  const bootstrap = PreVaultUserStateService.getCachedBootstrapState(
    params.userId,
  );
  if (bootstrap) return bootstrap.hasVault;
  return VaultService.peekVaultPresence(params.userId);
}

function resolveInitialBackendPhoneVerified(params: {
  userId: string | null | undefined;
  firebasePhoneVerified: boolean;
}): boolean | null {
  if (!params.userId) return null;
  if (params.firebasePhoneVerified) return true;

  const cached = AccountIdentityService.peekCachedIdentity(params.userId);
  if (cached && AccountIdentityService.hasVerifiedPhone(cached.data)) return true;
  const bootstrap = PreVaultUserStateService.getCachedBootstrapState(
    params.userId,
  );
  if (bootstrap?.phoneVerified !== null && bootstrap?.phoneVerified !== undefined) {
    return bootstrap.phoneVerified;
  }

  return cached
    ? AccountIdentityService.hasVerifiedPhone(cached.data)
    : null;
}

export function PhoneMandateGuard(props: {
  children: React.ReactNode;
  exemptVaultUsers?: boolean;
}) {
  const { user } = useAuth();
  return <AccountPhoneMandateGuard key={user?.uid ?? "signed-out"} {...props} />;
}

function AccountPhoneMandateGuard({
  children,
  exemptVaultUsers = false,
}: {
  children: React.ReactNode;
  exemptVaultUsers?: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const {
    user,
    loading,
    phoneNumber,
    retrySessionVerification,
    sessionVerificationRequired,
    signOut,
  } = useAuth();
  useSessionChromeSuppression(loading || sessionVerificationRequired);
  const hostname = useHostname();
  const hostnameResolved = hostname !== null;
  // Localhost only (never the dev deployment — see the service for the dead-loop
  // story). Bypassed sessions skip admission fetches entirely.
  const localPhoneMandateBypassed = shouldBypassPhoneMandateForLocalhost(hostname);
  const firebasePhoneVerified = hasVerifiedPhoneNumber(phoneNumber);
  // Hydrate both mandate signals from their shared caches on the first render.
  // The former effect-only approach rendered HushhLoader once on every remount
  // of a protected route, even when the profile route had all it needed to
  // continue safely. The effects below still own cold reads and revalidation.
  const [hasVault, setHasVault] = useState<boolean | null>(() =>
    resolveInitialVaultPresence({
      userId: user?.uid,
    }),
  );
  const [backendPhoneVerified, setBackendPhoneVerified] = useState<
    boolean | null
  >(() =>
    resolveInitialBackendPhoneVerified({
      userId: user?.uid,
      firebasePhoneVerified,
    }),
  );
  const [setupResolved, setSetupResolved] = useState(() =>
    !!user?.uid && PreVaultUserStateService.getCachedBootstrapState(user.uid)?.setupCompleted === true,
  );
  const [admissionError, setAdmissionError] = useState(false);
  const [retryAttempt, setRetryAttempt] = useState(0);
  const redirectTargetRef = useRef<string | null>(null);

  useEffect(() => {
    if (
      sessionVerificationRequired ||
      !user?.uid ||
      !hostnameResolved ||
      localPhoneMandateBypassed
    ) {
      return;
    }

    const userId = user.uid;
    const watchedKeys = new Set([
      CACHE_KEYS.VAULT_CHECK(userId),
      CACHE_KEYS.PRE_VAULT_BOOTSTRAP(userId),
      CACHE_KEYS.ACCOUNT_IDENTITY(userId),
    ]);
    const reconcileFromCache = () => {
      const bootstrap = PreVaultUserStateService.getCachedBootstrapState(userId);
      if (bootstrap) setSetupResolved(bootstrap.setupCompleted === true);
      const nextVaultPresence = resolveInitialVaultPresence({
        userId,
      });
      if (nextVaultPresence !== null) {
        setHasVault(nextVaultPresence);
      }

      const nextPhoneVerified = resolveInitialBackendPhoneVerified({
        userId,
        firebasePhoneVerified,
      });
      if (nextPhoneVerified !== null) {
        setBackendPhoneVerified(nextPhoneVerified);
      }
    };

    // The shared pre-vault bootstrap can settle just after this guard mounts.
    // Listen for its cache writes so a route transition resolves from that
    // session record instead of waiting on duplicate vault and identity reads.
    return CacheService.getInstance().subscribe((event) => {
      if (event.type === "set" && watchedKeys.has(event.key)) {
        reconcileFromCache();
      }
    });
  }, [
    firebasePhoneVerified,
    hostnameResolved,
    localPhoneMandateBypassed,
    sessionVerificationRequired,
    user?.uid,
  ]);

  useEffect(() => {
    const userId = user?.uid;
    if (sessionVerificationRequired) return;
    if (!userId) {
      setHasVault(null);
      setBackendPhoneVerified(null);
      return;
    }

    // useHostname intentionally starts as null to avoid a hydration mismatch.
    // No admission fetch may begin before it resolves: a localhost session is
    // exempt from the client mandate, so treating that first render as a
    // remote host creates both duplicate reads and a redirect loop.
    if (!hostnameResolved) {
      setHasVault(null);
      setBackendPhoneVerified(null);
      return;
    }

    if (localPhoneMandateBypassed) {
      setHasVault(false);
      setBackendPhoneVerified(false);
      return;
    }

    let cancelled = false;
    setAdmissionError(false);
    // `boolean | null`, because the bootstrap state now reports "not read
    // yet" as null instead of flattening it to false. This component already
    // handles that: null holds the redirect (`hasVault !== null` below) and
    // renders the loader rather than deciding. Only this setter was narrower
    // than the value it receives.
    const setVaultPresence = (next: boolean | null) => {
      if (!cancelled) {
        setHasVault((current) => (current === next ? current : next));
      }
    };
    const setPhoneVerified = (next: boolean) => {
      if (!cancelled) {
        setBackendPhoneVerified(
          next || AccountIdentityService.hasVerifiedPhone(
            AccountIdentityService.peekCachedIdentity(userId)?.data,
          ),
        );
      }
    };

    const resolveIdentityFallback = async () => {
      if (firebasePhoneVerified) {
        setPhoneVerified(true);
        return;
      }
      // The reviewer bridge already bypasses the phone mandate. Do not create
      // an identity-shadow write merely to resolve an admission state that the
      // read-only rehearsal will never enforce.
      if (shouldSkipAmbientIdentityHydrationForAutomation()) {
        setPhoneVerified(false);
        return;
      }
      try {
        const { identity } = await AccountIdentityService.getIdentitySwr(user);
        if (!identity) throw new Error("Account identity is unavailable");
        setPhoneVerified(AccountIdentityService.hasVerifiedPhone(identity));
      } catch (error) {
        console.warn("[PhoneMandateGuard] Failed to check account phone claim:", error);
        if (!cancelled) setAdmissionError(true);
      }
    };

    const cachedBootstrap = PreVaultUserStateService.getCachedBootstrapState(userId);
    if (cachedBootstrap && retryAttempt === 0 &&
        (cachedBootstrap.hasVault !== null || cachedBootstrap.setupCompleted === true)) {
      setSetupResolved(cachedBootstrap.setupCompleted === true);
      setVaultPresence(cachedBootstrap.hasVault);
      if (firebasePhoneVerified) {
        setPhoneVerified(true);
      } else if (cachedBootstrap.phoneVerified != null) {
        setPhoneVerified(cachedBootstrap.phoneVerified);
      } else if (cachedBootstrap.hasVault !== true && cachedBootstrap.setupCompleted !== true) {
        void resolveIdentityFallback();
      }
      return () => {
        cancelled = true;
      };
    }

    // The versioned pre-vault bootstrap is the shared authenticated admission
    // resource. Its single-flight promise is shared with the app runtime and
    // onboarding guard, so a cold route transition performs one request for
    // vault presence, phone claim, and journey state rather than independent
    // vault and identity checks from each layout.
    void PreVaultUserStateService.bootstrapState(userId, { force: retryAttempt > 0 || cachedBootstrap?.hasVault === null })
      .then((state) => {
        if (cancelled) return;
        if (state.hasVault === null && state.setupCompleted !== true) {
          throw new Error("Account onboarding is unavailable");
        }
        setSetupResolved(state.setupCompleted === true);
        setVaultPresence(state.hasVault);
        if (firebasePhoneVerified) {
          setPhoneVerified(true);
        } else if (state.phoneVerified != null) {
          setPhoneVerified(state.phoneVerified);
        } else if (state.hasVault !== true && state.setupCompleted !== true) {
          void resolveIdentityFallback();
        }
      })
      .catch((error) => {
        console.warn("[PhoneMandateGuard] Failed to load admission state:", error);
        // A failed read says nothing about vault ownership or phone status.
        if (!cancelled) setAdmissionError(true);
      });

    return () => {
      cancelled = true;
    };
    // User identity is deliberately keyed by uid: Firebase may recreate its
    // object during token refreshes, but that must not restart admission.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    retryAttempt,
    firebasePhoneVerified,
    hostnameResolved,
    localPhoneMandateBypassed,
    sessionVerificationRequired,
    user?.uid,
  ]);

  const currentRoute = useMemo(() => {
    const query = searchParams.toString();
    return query ? `${pathname}?${query}` : pathname;
  }, [pathname, searchParams]);

  const shouldRedirect =
    !loading &&
    !admissionError &&
    !sessionVerificationRequired &&
    !!user &&
    hostnameResolved &&
    hasVault !== null &&
    backendPhoneVerified !== null &&
    shouldRequirePhoneMandate({
      phoneNumber,
      phoneVerified: backendPhoneVerified,
      hasVault,
      setupResolved,
      exemptVaultUsers,
      hostname,
      pathname,
    });

  useEffect(() => {
    if (!shouldRedirect || isPhoneMandatePath(pathname)) {
      redirectTargetRef.current = null;
      return;
    }

    const redirectTarget = buildPhoneMandateRoute(currentRoute);
    if (redirectTargetRef.current === redirectTarget) {
      return;
    }
    redirectTargetRef.current = redirectTarget;
    router.replace(redirectTarget);
  }, [currentRoute, pathname, router, shouldRedirect]);

  if (loading) {
    return <HushhLoader label="Checking session..." />;
  }

  if (sessionVerificationRequired) {
    return (
      <SessionVerificationRecovery
        onRetry={() => void retrySessionVerification()}
        onSignOut={() => void signOut({ skipFcmCleanup: true })}
      />
    );
  }

  if (!user) {
    return <>{children}</>;
  }

  if (admissionError) {
    return (
      <SessionVerificationRecovery
        onRetry={() => setRetryAttempt((attempt) => attempt + 1)}
        onSignOut={() => void signOut({ skipFcmCleanup: true })}
      />
    );
  }

  // A null hostname is the intentional SSR/client-hydration state from
  // useHostname. Redirecting before it resolves treats localhost as an
  // untrusted host for one render and can bounce a locally bypassed session
  // straight back to /register-phone. Hold the protected surface briefly
  // instead; once the host is known the normal mandate policy applies.
  if (!hostnameResolved ||
      (!setupResolved && hasVault !== true && (hasVault === null || backendPhoneVerified === null))) {
    return <HushhLoader label="Checking phone requirement..." />;
  }

  if (shouldRedirect && !isPhoneMandatePath(pathname)) {
    return <HushhLoader label="Opening phone verification..." />;
  }

  return <>{children}</>;
}
