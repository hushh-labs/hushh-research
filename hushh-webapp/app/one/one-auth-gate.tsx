"use client";

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";

import { PhoneMandateGuard } from "@/components/auth/phone-mandate-guard";
import { OneOnboardingGuard } from "@/components/kai/onboarding/kai-onboarding-guard";
import { VaultLockGuard } from "@/components/vault/vault-lock-guard";
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
export function OneAuthGate({ children }: { children: ReactNode }) {
  const pathname = usePathname();

  if (isPublicRoute(pathname ?? "")) {
    return <>{children}</>;
  }

  return (
    <VaultLockGuard>
      <PhoneMandateGuard>
        <OneOnboardingGuard>{children}</OneOnboardingGuard>
      </PhoneMandateGuard>
    </VaultLockGuard>
  );
}
