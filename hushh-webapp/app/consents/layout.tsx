"use client";

import { Suspense, type ReactNode } from "react";
import { PhoneMandateGuard } from "@/components/auth/phone-mandate-guard";
import { VaultLockGuard } from "@/components/vault/vault-lock-guard";

export default function ConsentsLayout({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={null}>
      <VaultLockGuard>
        <PhoneMandateGuard>{children}</PhoneMandateGuard>
      </VaultLockGuard>
    </Suspense>
  );
}
