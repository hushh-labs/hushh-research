import type { ReactNode } from "react";

import { PhoneMandateGuard } from "@/components/auth/phone-mandate-guard";
import { VaultLockGuard } from "@/components/vault/vault-lock-guard";

export default function PkmAgentLabLayout({ children }: { children: ReactNode }) {
  return (
    <VaultLockGuard>
      <PhoneMandateGuard>{children}</PhoneMandateGuard>
    </VaultLockGuard>
  );
}
