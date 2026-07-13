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
          {/* Apple-style swipe pager: a horizontal swipe hops to the adjacent
              RIA tab while the pinned chrome stays put. RIA-scoped by
              construction — this layout does not wrap /marketplace, so Connect
              keeps its own card-deck swipe. Guards above are untouched. */}
          <RiaSwipePager>{children}</RiaSwipePager>
        </RouteErrorBoundary>
      </PhoneMandateGuard>
    </VaultLockGuard>
  );
}
