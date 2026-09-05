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

  const bootstrap = PreVaultUserStateService.getCachedBootstrapState(
    params.userId,
  );
  if (bootstrap?.phoneVerified !== null && bootstrap?.phoneVerified !== undefined) {
    return bootstrap.phoneVerified;
  }

  const cached = AccountIdentityService.peekCachedIdentity(params.userId);
  return cached
    ? AccountIdentityService.hasVerifiedPhone(cached.data)
    : null;
}

export function PhoneMandateGuard({
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
        setBackendPhoneVerified((current) => (current === next ? current : next));
      }
    };

    const resolveIdentityFallback = async () => {
      if (firebasePhoneVerified) {
        setPhoneVerified(true);
        return;
      }
      try {
        const { identity } = await AccountIdentityService.getIdentitySwr(user);
        setPhoneVerified(AccountIdentityService.hasVerifiedPhone(identity));
      } catch (error) {
        console.warn("[PhoneMandateGuard] Failed to check account phone claim:", error);
        setPhoneVerified(false);
      }
    };

    const cachedBootstrap = PreVaultUserStateService.getCachedBootstrapState(userId);
    if (cachedBootstrap) {
      setVaultPresence(cachedBootstrap.hasVault);
      if (firebasePhoneVerified) {
        setPhoneVerified(true);
      } else if (cachedBootstrap.phoneVerified !== null) {
        setPhoneVerified(cachedBootstrap.phoneVerified);
      } else {
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
    void PreVaultUserStateService.bootstrapState(userId)
      .then((state) => {
        setVaultPresence(state.hasVault);
        if (firebasePhoneVerified) {
          setPhoneVerified(true);
        } else if (state.phoneVerified !== null) {
          setPhoneVerified(state.phoneVerified);
        } else {
          void resolveIdentityFallback();
        }
      })
      .catch((error) => {
        console.warn("[PhoneMandateGuard] Failed to load admission state:", error);
        // Fail closed when the shared admission record cannot be verified.
        setVaultPresence(true);
        setPhoneVerified(firebasePhoneVerified);
      });

    return () => {
      cancelled = true;
    };
    // User identity is deliberately keyed by uid: Firebase may recreate its
    // object during token refreshes, but that must not restart admission.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
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
    !sessionVerificationRequired &&
    !!user &&
    hostnameResolved &&
    hasVault !== null &&
    backendPhoneVerified !== null &&
    shouldRequirePhoneMandate({
      phoneNumber,
      phoneVerified: backendPhoneVerified,
      hasVault,
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

  // A null hostname is the intentional SSR/client-hydration state from
  // useHostname. Redirecting before it resolves treats localhost as an
  // untrusted host for one render and can bounce a locally bypassed session
  // straight back to /register-phone. Hold the protected surface briefly
  // instead; once the host is known the normal mandate policy applies.
  if (!hostnameResolved || hasVault === null || backendPhoneVerified === null) {
    return <HushhLoader label="Checking phone requirement..." />;
  }

  if (shouldRedirect && !isPhoneMandatePath(pathname)) {
    return <HushhLoader label="Opening phone verification..." />;
  }

  return <>{children}</>;
}
