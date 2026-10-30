"use client";

import { VaultLockGuard } from "@/components/vault/vault-lock-guard";
import { RouteErrorBoundary } from "@/components/app-ui/route-error-boundary";
import { PhoneMandateGuard } from "@/components/auth/phone-mandate-guard";

export default function RiaLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <VaultLockGuard>
      <PhoneMandateGuard>
        <RouteErrorBoundary fallbackRoute="/ria">{children}</RouteErrorBoundary>
      </PhoneMandateGuard>
    </VaultLockGuard>
  );
}
