import { Suspense } from "react";

import ConnectPageClient from "./page-client";
import { VaultLockGuard } from "@/components/vault/vault-lock-guard";

export default function ConnectPage() {
  return (
    <VaultLockGuard>
      <Suspense fallback={null}>
        <ConnectPageClient />
      </Suspense>
    </VaultLockGuard>
  );
}
