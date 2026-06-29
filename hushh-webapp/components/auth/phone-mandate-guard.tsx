"use client";

import { useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { HushhLoader } from "@/components/app-ui/hushh-loader";
import { useAuth } from "@/lib/firebase/auth-context";
import { buildPhoneMandateRoute, ROUTES } from "@/lib/navigation/routes";
import { AccountIdentityService } from "@/lib/services/account-identity-service";
import {
  hasVerifiedPhoneNumber,
  shouldBypassPhoneMandateForLocalhost,
  shouldRequirePhoneMandate,
} from "@/lib/services/phone-mandate-service";
import { VaultService } from "@/lib/services/vault-service";
import { useHostname } from "@/lib/hooks/use-hostname";

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
  const [hasVault, setHasVault] = useState<boolean | null>(null);
  const [backendPhoneVerified, setBackendPhoneVerified] = useState<boolean | null>(null);
  const hostname = useHostname();
  const localPhoneMandateBypassed = shouldBypassPhoneMandateForLocalhost(hostname);
  const firebasePhoneVerified = hasVerifiedPhoneNumber(phoneNumber);

  useEffect(() => {
    if (!user?.uid) {
      setHasVault(null);
      return;
    }

    if (localPhoneMandateBypassed) {
      setHasVault(false);
      return;
    }

    const userId = user.uid;
    let cancelled = false;

    // VaultService is the single shared, SWR-grade vault-presence cache
    // (CacheService + sessionStorage + in-flight dedup). Hydrate the first
    // paint synchronously from that cache, then fall back to the async check
    // only on a cold cache.
    const cachedPresence = VaultService.peekVaultPresence(userId);
    if (cachedPresence !== null) {
      setHasVault(cachedPresence);
      return;
    }

    const loadVaultState = async () => {
      try {
        const exists = await VaultService.checkVault(userId);
        if (!cancelled) {
          setHasVault(exists);
        }
      } catch (error) {
        console.warn("[PhoneMandateGuard] Failed to check vault presence:", error);
        if (!cancelled) {
          setHasVault(true);
        }
      }
    };

    void loadVaultState();

    return () => {
      cancelled = true;
    };
  }, [localPhoneMandateBypassed, user?.uid]);

  useEffect(() => {
    if (!user?.uid) {
      setBackendPhoneVerified(null);
      return;
    }

    if (localPhoneMandateBypassed) {
      setBackendPhoneVerified(false);
      return;
    }

    if (firebasePhoneVerified) {
      setBackendPhoneVerified(true);
      return;
    }

    let cancelled = false;

    // Stale-while-revalidate: paint the last-known phone status instantly from
    // cache (even if stale) so route re-mounts never flash a loader, then
    // revalidate in the background. Only show the cold-cache loading state when
    // there is no cached value at all.
    const cached = AccountIdentityService.peekCachedIdentity(user.uid);
    if (cached) {
      setBackendPhoneVerified(AccountIdentityService.hasVerifiedPhone(cached.data));
    } else {
      setBackendPhoneVerified(null);
    }

    const loadIdentityState = async () => {
      try {
        // getIdentitySwr returns the cached value immediately (warming the
        // state above) and revalidates in the background when stale. On a cold
        // cache it performs a single non-forced fetch. Forced freshness is
        // maintained by the sync paths at login and after a phone claim.
        const { identity } = await AccountIdentityService.getIdentitySwr(user);
        if (!cancelled) {
          setBackendPhoneVerified(AccountIdentityService.hasVerifiedPhone(identity));
        }
      } catch (error) {
        console.warn("[PhoneMandateGuard] Failed to check account phone claim:", error);
        if (!cancelled && cached == null) {
          setBackendPhoneVerified(false);
        }
      }
    };

    void loadIdentityState();

    return () => {
      cancelled = true;
    };
    // Intentionally key on `user?.uid` (stable identity) rather than the whole
    // `user` object, which Firebase re-creates on every token refresh and would
    // otherwise re-run this guard (and its network reads) needlessly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firebasePhoneVerified, localPhoneMandateBypassed, user?.uid]);

  const currentRoute = useMemo(() => {
    const query = searchParams.toString();
    return query ? `${pathname}?${query}` : pathname;
  }, [pathname, searchParams]);

  const shouldRedirect =
    !!user &&
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
      return;
    }

    router.replace(buildPhoneMandateRoute(currentRoute));
  }, [currentRoute, pathname, router, shouldRedirect]);

  if (loading) {
    return <HushhLoader label="Checking session..." />;
  }

  if (!user) {
    return <>{children}</>;
  }

  if (hasVault === null || backendPhoneVerified === null) {
    return <HushhLoader label="Checking phone requirement..." />;
  }

  if (shouldRedirect && pathname !== ROUTES.PHONE_MANDATE) {
    return <HushhLoader label="Opening phone verification..." />;
  }

  return <>{children}</>;
}
