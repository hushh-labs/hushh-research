"use client";

import type { ReactNode } from "react";
import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";

import { PhoneMandateGuard } from "@/components/auth/phone-mandate-guard";
import { HushhLoader } from "@/components/app-ui/hushh-loader";
import { OneOnboardingGuard } from "@/components/kai/onboarding/kai-onboarding-guard";
import { VaultLockGuard } from "@/components/vault/vault-lock-guard";
import { useAuth } from "@/hooks/use-auth";
import { isPublicRoute } from "@/lib/navigation/routes";

/**
 * OneAuthGate - conditionally applies the vault + phone + onboarding guards to
 * `/one/*` routes.
 *
 * Most One surfaces are private and must stay behind VaultLockGuard +
 * PhoneMandateGuard + OneOnboardingGuard. However, a small set of One routes
 * are intentionally public - notably shared temporary location links at
 * `/one/location/request/[token]`. Anyone who receives such a link must be
 * able to open it and view the shared live location WITHOUT signing in or
 * having a Hushh account.
 *
 * The source of truth for "which One routes are public" is `isPublicRoute()`
 * in lib/navigation/routes.ts, which the server-side middleware (proxy.ts)
 * already honors. This gate mirrors that contract on the client so the layout
 * does not redirect anonymous visitors of public links to /login.
 *
 * Guard order for private routes: authentication/vault -> phone mandate ->
 * root setup gate. OneOnboardingGuard hard-gates the whole /one/* surface:
 * a user who has not resolved the root setup flow can only reach
 * /one/setup and its sub-routes (the guard allows those through); everything
 * else redirects to /one/setup until the gate is satisfied. It sits INSIDE the
 * public-route bypass so anonymous visitors of public links are never gated.
 */
/**
 * Routes that stay signed-in-gated but skip the hard vault wall. The CRM
 * systems overview lists registry metadata only (backend accepts a Firebase
 * ID token for it), and the workspace surfaces its own inline unlock CTA for
 * record-level actions, so forcing the full-screen vault gate here just
 * blocks a read-only overview.
 */
const SOFT_VAULT_ROUTE_PREFIXES = ["/one/connected-systems"] as const;

function isSoftVaultRoute(pathname: string): boolean {
  return SOFT_VAULT_ROUTE_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  );
}

/**
 * Sign-in gate without the vault wall: VaultLockGuard normally owns the
 * login redirect, so soft-vault routes need their own (PhoneMandateGuard
 * renders children for anonymous users rather than redirecting).
 */
function SignedInGate({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (loading || user) return;
    if (typeof window !== "undefined") {
      const currentPath = window.location.pathname;
      router.replace(`/login?redirect=${encodeURIComponent(currentPath)}`);
    }
  }, [loading, router, user]);

  if (loading) {
    return <HushhLoader label="Checking session..." />;
  }
  if (!user) {
    return <HushhLoader label="Redirecting to login..." />;
  }
  return <>{children}</>;
}

export function OneAuthGate({ children }: { children: ReactNode }) {
  const pathname = usePathname();

  if (isPublicRoute(pathname ?? "")) {
    return <>{children}</>;
  }

  if (isSoftVaultRoute(pathname ?? "")) {
    return (
      <SignedInGate>
        <PhoneMandateGuard>
          <OneOnboardingGuard>{children}</OneOnboardingGuard>
        </PhoneMandateGuard>
      </SignedInGate>
    );
  }

  return (
    <VaultLockGuard>
      <PhoneMandateGuard>
        <OneOnboardingGuard>{children}</OneOnboardingGuard>
      </PhoneMandateGuard>
    </VaultLockGuard>
  );
}
