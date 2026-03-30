import type { ReactNode } from "react";

import { VaultLockGuard } from "@/components/vault/vault-lock-guard";

export default function PkmAgentLabLayout({ children }: { children: ReactNode }) {
  return <VaultLockGuard>{children}</VaultLockGuard>;
}
