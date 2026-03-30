"use client";

import { VaultLockGuard } from "@/components/vault/vault-lock-guard";
import { RouteErrorBoundary } from "@/components/app-ui/route-error-boundary";

export default function RiaLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <VaultLockGuard>
      <RouteErrorBoundary fallbackRoute="/ria">{children}</RouteErrorBoundary>
    </VaultLockGuard>
  );
}
