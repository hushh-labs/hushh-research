"use client";

import { useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { HushhLoader } from "@/components/app-ui/hushh-loader";
import { useAuth } from "@/lib/firebase/auth-context";
import { buildPhoneMandateRoute, ROUTES } from "@/lib/navigation/routes";
import {
  shouldBypassPhoneMandateForLocalhost,
  shouldRequirePhoneMandate,
} from "@/lib/services/phone-mandate-service";
import { VaultService } from "@/lib/services/vault-service";

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
  const hostname = typeof window === "undefined" ? null : window.location.hostname;
  const localPhoneMandateBypassed = shouldBypassPhoneMandateForLocalhost(hostname);

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

  const currentRoute = useMemo(() => {
    const query = searchParams.toString();
    return query ? `${pathname}?${query}` : pathname;
  }, [pathname, searchParams]);

  const shouldRedirect =
    !!user &&
    hasVault !== null &&
    shouldRequirePhoneMandate({
      phoneNumber,
      hasVault,
      exemptVaultUsers,
      hostname,
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

  if (hasVault === null) {
    return <HushhLoader label="Checking phone requirement..." />;
  }

  if (shouldRedirect && pathname !== ROUTES.PHONE_MANDATE) {
    return <HushhLoader label="Opening phone verification..." />;
  }

  return <>{children}</>;
}
