"use client";

import { Suspense, type ReactNode } from "react";
import { PhoneMandateGuard } from "@/components/auth/phone-mandate-guard";

export default function MarketplaceLayout({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={null}>
      <PhoneMandateGuard exemptVaultUsers>{children}</PhoneMandateGuard>
    </Suspense>
  );
}
