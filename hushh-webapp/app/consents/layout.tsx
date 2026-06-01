import type { Metadata } from "next";
import type { ReactNode } from "react";

import { PhoneMandateGuard } from "@/components/auth/phone-mandate-guard";
import { VaultLockGuard } from "@/components/vault/vault-lock-guard";

export const metadata: Metadata = {
  title: "Consents",
};

export default function ConsentsLayout({ children }: { children: ReactNode }) {
  return (
    <VaultLockGuard>
      <PhoneMandateGuard>{children}</PhoneMandateGuard>
    </VaultLockGuard>
  );
}
