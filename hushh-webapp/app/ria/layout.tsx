"use client";

import { VaultLockGuard } from "@/components/vault/vault-lock-guard";
import { RouteErrorBoundary } from "@/components/app-ui/route-error-boundary";
import { PhoneMandateGuard } from "@/components/auth/phone-mandate-guard";
import { RiaSwipePager } from "@/components/ria/layout/ria-swipe-pager";

export default function RiaLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <VaultLockGuard>
      <PhoneMandateGuard>
        <RouteErrorBoundary fallbackRoute="/ria">
          {/* The onboarding wrapper owns only its five local wizard steps.
              Profile, Clients, and Picks use the shared route-tab gesture in
              the app shell, so their route transition and tab motion stay in
              parity with every other top-shell workspace. */}
          <RiaSwipePager>{children}</RiaSwipePager>
        </RouteErrorBoundary>
      </PhoneMandateGuard>
    </VaultLockGuard>
  );
}
