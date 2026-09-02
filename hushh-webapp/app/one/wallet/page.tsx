import { Suspense } from "react";

import { WalletWorkspace } from "@/components/wallet/wallet-workspace";
import { RouteSuspenseFallback } from "@/components/system/route-suspense-fallback";

export default function OneWalletPage() {
  // WalletWorkspace reads search and page from the URL, which needs a Suspense
  // boundary for static rendering (same shape as the Consent Center page).
  return (
    <Suspense fallback={<RouteSuspenseFallback label="Loading cards…" />}>
      <WalletWorkspace />
    </Suspense>
  );
}
