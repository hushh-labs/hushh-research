import { Suspense } from "react";

import { WalletWorkspace } from "@/components/wallet/wallet-workspace";
import { WalletCollectionSkeleton } from "@/components/wallet/wallet-collection-skeleton";
import { AppPageShell, AppPageContentRegion } from "@/components/app-ui/app-page-shell";

export default function OneWalletPage() {
  // WalletWorkspace reads search and page from the URL, which needs a Suspense
  // boundary for static rendering (same shape as the Consent Center page).
  return (
    <Suspense fallback={<AppPageShell width="standard" headerContentSpacing="compact" fitContent><AppPageContentRegion><div className="mx-auto w-full max-w-[1080px]"><WalletCollectionSkeleton owned /></div></AppPageContentRegion></AppPageShell>}>
      <WalletWorkspace />
    </Suspense>
  );
}
