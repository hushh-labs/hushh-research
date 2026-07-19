"use client";

import type { ReactNode } from "react";
import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";

import { PhoneMandateGuard } from "@/components/auth/phone-mandate-guard";
import { HushhLoader } from "@/components/app-ui/hushh-loader";
import { VaultLockGuard } from "@/components/vault/vault-lock-guard";
import { useAuth } from "@/hooks/use-auth";
import { isPublicRoute, ROUTES } from "@/lib/navigation/routes";
import { useSessionChromeSuppression } from "@/lib/auth/use-session-chrome-suppression";

/**
 * OneAuthGate - conditionally applies the vault + phone + onboarding guards to
 * `/one/*` routes.
 *
 * Most One surfaces are private and must stay behind VaultLockGuard +
 * PhoneMandateGuard. Root setup admission is applied once app-wide by
 * OnboardingJourneyGuard. However, a small set of One routes
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
 * root setup gate. The app-wide guard handles that decision after Firebase
 * identity settles, including non-One route families.
 */
/**
 * OAuth callbacks need an authenticated Firebase identity but cannot depend on
 * an in-memory vault key surviving the external provider round trip. Every
 * other private One route uses the hard vault gate below.
 */
const AUTH_ONLY_ROUTE_PREFIXES = [ROUTES.PROFILE_GMAIL_OAUTH_RETURN] as const;

function isAuthOnlyRoute(pathname: string): boolean {
  return AUTH_ONLY_ROUTE_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

/**
 * Sign-in gate without the vault wall: VaultLockGuard normally owns the
 * login redirect, so external callback routes need their own (PhoneMandateGuard
 * renders children for anonymous users rather than redirecting).
 */
function SignedInGate({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const router = useRouter();
  useSessionChromeSuppression(loading);

  useEffect(() => {
    if (loading || user) return;
    if (typeof window !== "undefined") {
      const currentPath =
        window.location.pathname +
        window.location.search +
        window.location.hash;
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

  if (isAuthOnlyRoute(pathname ?? "")) {
    return (
      <SignedInGate>
        <PhoneMandateGuard>{children}</PhoneMandateGuard>
      </SignedInGate>
    );
  }

  return (
    <VaultLockGuard>
      <PhoneMandateGuard>{children}</PhoneMandateGuard>
    </VaultLockGuard>
  );
}
