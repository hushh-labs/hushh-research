import type { ReactNode } from "react";

import { PhoneMandateGuard } from "@/components/auth/phone-mandate-guard";
import { VaultLockGuard } from "@/components/vault/vault-lock-guard";

export default function OneConsentLayout({ children }: { children: ReactNode }) {
  return (
    <PhoneMandateGuard>
      <VaultLockGuard>{children}</VaultLockGuard>
    </PhoneMandateGuard>
  );
}
