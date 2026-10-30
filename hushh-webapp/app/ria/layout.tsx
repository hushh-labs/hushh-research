"use client";

import { VaultLockGuard } from "@/components/vault/vault-lock-guard";
import { RouteErrorBoundary } from "@/components/app-ui/route-error-boundary";
import { PhoneMandateGuard } from "@/components/auth/phone-mandate-guard";
import { RiaSwipePager } from "@/components/ria/layout/ria-swipe-pager";
import { RiaPrimaryWorkspaceShell } from "@/components/ria/ria-page-shell";

export default function RiaLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <VaultLockGuard>
      <PhoneMandateGuard>
        <RouteErrorBoundary fallbackRoute="/ria">
          {/* The primary workspace shell persists across Profile, Clients, and
              Picks. The onboarding wrapper still owns only its five local
              wizard steps. */}
          <RiaPrimaryWorkspaceShell>
            <RiaSwipePager>{children}</RiaSwipePager>
          </RiaPrimaryWorkspaceShell>
        </RouteErrorBoundary>
      </PhoneMandateGuard>
    </VaultLockGuard>
  );
}
