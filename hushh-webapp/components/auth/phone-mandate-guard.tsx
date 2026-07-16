"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { HushhLoader } from "@/components/app-ui/hushh-loader";
import { useAuth } from "@/lib/firebase/auth-context";
import { buildPhoneMandateRoute, ROUTES } from "@/lib/navigation/routes";
import { AccountIdentityService } from "@/lib/services/account-identity-service";
import { CacheService, CACHE_KEYS } from "@/lib/services/cache-service";
import {
  hasVerifiedPhoneNumber,
  shouldBypassPhoneMandateForLocalhost,
  shouldRequirePhoneMandate,
} from "@/lib/services/phone-mandate-service";
import { PreVaultUserStateService } from "@/lib/services/pre-vault-user-state-service";
import { VaultService } from "@/lib/services/vault-service";
import { useHostname } from "@/lib/hooks/use-hostname";
import { useSessionChromeSuppression } from "@/lib/auth/use-session-chrome-suppression";

function resolveInitialVaultPresence(params: {
  userId: string | null | undefined;
  hostnameResolved: boolean;
  localPhoneMandateBypassed: boolean;
}): boolean | null {
  if (!params.userId || !params.hostnameResolved) return null;
  if (params.localPhoneMandateBypassed) return false;
  const bootstrap = PreVaultUserStateService.getCachedBootstrapState(
    params.userId,
  );
  if (bootstrap) return bootstrap.hasVault;
  return VaultService.peekVaultPresence(params.userId);
}

function resolveInitialBackendPhoneVerified(params: {
  userId: string | null | undefined;
  hostnameResolved: boolean;
  firebasePhoneVerified: boolean;
  localPhoneMandateBypassed: boolean;
}): boolean | null {
  if (!params.userId || !params.hostnameResolved) return null;
  if (params.localPhoneMandateBypassed) return false;
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
  const { user, loading, phoneNumber } = useAuth();
  useSessionChromeSuppression(loading);
  const hostname = useHostname();
  const hostnameResolved = hostname !== null;
  const localPhoneMandateBypassed = shouldBypassPhoneMandateForLocalhost(hostname);
  const firebasePhoneVerified = hasVerifiedPhoneNumber(phoneNumber);
  // Hydrate both mandate signals from their shared caches on the first render.
  // The former effect-only approach rendered HushhLoader once on every remount
  // of a protected route, even when the profile route had all it needed to
  // continue safely. The effects below still own cold reads and revalidation.
  const [hasVault, setHasVault] = useState<boolean | null>(() =>
    resolveInitialVaultPresence({
      userId: user?.uid,
      hostnameResolved,
      localPhoneMandateBypassed,
    }),
  );
  const [backendPhoneVerified, setBackendPhoneVerified] = useState<
    boolean | null
  >(() =>
    resolveInitialBackendPhoneVerified({
      userId: user?.uid,
      hostnameResolved,
      firebasePhoneVerified,
      localPhoneMandateBypassed,
    }),
  );
  const redirectTargetRef = useRef<string | null>(null);

  useEffect(() => {
    if (!user?.uid || !hostnameResolved || localPhoneMandateBypassed) {
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
        hostnameResolved,
        localPhoneMandateBypassed,
      });
      if (nextVaultPresence !== null) {
        setHasVault(nextVaultPresence);
      }

      const nextPhoneVerified = resolveInitialBackendPhoneVerified({
        userId,
        hostnameResolved,
        firebasePhoneVerified,
        localPhoneMandateBypassed,
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
  }, [firebasePhoneVerified, hostnameResolved, localPhoneMandateBypassed, user?.uid]);

  useEffect(() => {
    const userId = user?.uid;
    if (!userId) {
      setHasVault(null);
      setBackendPhoneVerified(null);
      return;
    }

    // useHostname intentionally starts as null to avoid a hydration mismatch.
    // No admission fetch may begin before it resolves: a localhost session is
    // exempt from phone verification, so treating that first render as a
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
    const setVaultPresence = (next: boolean) => {
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
  }, [firebasePhoneVerified, hostnameResolved, localPhoneMandateBypassed, user?.uid]);

  const currentRoute = useMemo(() => {
    const query = searchParams.toString();
    return query ? `${pathname}?${query}` : pathname;
  }, [pathname, searchParams]);

  const shouldRedirect =
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
    if (!shouldRedirect || pathname === ROUTES.PHONE_MANDATE) {
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

  if (shouldRedirect && pathname !== ROUTES.PHONE_MANDATE) {
    return <HushhLoader label="Opening phone verification..." />;
  }

  return <>{children}</>;
}
