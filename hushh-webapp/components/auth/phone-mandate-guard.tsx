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

const vaultPresenceCache = new Map<string, boolean>();

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

    if (vaultPresenceCache.has(user.uid)) {
      setHasVault(vaultPresenceCache.get(user.uid) ?? null);
      return;
    }

    let cancelled = false;

    const loadVaultState = async () => {
      try {
        const exists = await VaultService.checkVault(user.uid);
        if (!cancelled) {
          vaultPresenceCache.set(user.uid, exists);
          setHasVault(exists);
        }
      } catch (error) {
        console.warn("[PhoneMandateGuard] Failed to check vault presence:", error);
        if (!cancelled) {
          vaultPresenceCache.set(user.uid, true);
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

    const loadIdentityState = async () => {
      try {
        const identity = await AccountIdentityService.refreshCurrentUserIdentity(user);
        if (!cancelled) {
          setBackendPhoneVerified(AccountIdentityService.hasVerifiedPhone(identity));
        }
      } catch (error) {
        console.warn("[PhoneMandateGuard] Failed to check account phone claim:", error);
        if (!cancelled) {
          setBackendPhoneVerified(false);
        }
      }
    };

    setBackendPhoneVerified(null);
    void loadIdentityState();

    return () => {
      cancelled = true;
    };
  }, [firebasePhoneVerified, localPhoneMandateBypassed, user]);

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
