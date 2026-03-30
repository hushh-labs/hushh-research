"use client";

/**
 * Kai Layout - Minimal Mobile-First
 *
 * Wraps all /kai routes with VaultLockGuard and onboarding guard.
 */

import { VaultLockGuard } from "@/components/vault/vault-lock-guard";
import { KaiOnboardingGuard } from "@/components/kai/onboarding/kai-onboarding-guard";
import { KaiNavTour } from "@/components/kai/onboarding/kai-nav-tour";
import { VaultMethodPrompt } from "@/components/vault/vault-method-prompt";
import { RouteErrorBoundary } from "@/components/app-ui/route-error-boundary";
import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { useAuth } from "@/lib/firebase/auth-context";
import { useVault } from "@/lib/vault/vault-context";
import { UnlockWarmOrchestrator } from "@/lib/services/unlock-warm-orchestrator";
import { ROUTES } from "@/lib/navigation/routes";

export default function KaiLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const { user } = useAuth();
  const { vaultKey, vaultOwnerToken } = useVault();
  const onOnboardingRoute = pathname.startsWith("/kai/onboarding");
  const onImportRoute = pathname.startsWith("/kai/import");
  const onPlaidOauthReturnRoute = pathname === ROUTES.KAI_PLAID_OAUTH_RETURN;
  const shouldEnableMethodPrompt = !onOnboardingRoute && !onImportRoute && !onPlaidOauthReturnRoute;

  useEffect(() => {
    if (onOnboardingRoute || onImportRoute) return;
    if (!user?.uid || !vaultKey || !vaultOwnerToken) return;

    void UnlockWarmOrchestrator.run({
      userId: user.uid,
      vaultKey,
      vaultOwnerToken,
      routePath: pathname,
    }).catch((error) => {
      console.warn("[KaiLayout] Route-priority warm orchestration failed:", error);
    });
  }, [onImportRoute, onOnboardingRoute, pathname, user?.uid, vaultKey, vaultOwnerToken]);

  const shell = (
    <RouteErrorBoundary fallbackRoute="/kai">
      <div className="flex min-h-screen flex-col [--morphy-glass-accent-a:rgba(148,163,184,0.08)] [--morphy-glass-accent-b:rgba(226,232,240,0.08)] dark:[--morphy-glass-accent-a:rgba(63,63,70,0.16)] dark:[--morphy-glass-accent-b:rgba(82,82,91,0.14)]">
        <main className="flex-1 pb-0">
          {children}
        </main>
        <VaultMethodPrompt enabled={shouldEnableMethodPrompt} />
        {onPlaidOauthReturnRoute ? null : <KaiNavTour />}
      </div>
    </RouteErrorBoundary>
  );

  if (onPlaidOauthReturnRoute) {
    return shell;
  }

  return (
    <VaultLockGuard>
      <KaiOnboardingGuard>{shell}</KaiOnboardingGuard>
    </VaultLockGuard>
  );
}
