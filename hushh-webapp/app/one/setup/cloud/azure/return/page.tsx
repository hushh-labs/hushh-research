import { Suspense } from "react";

import { HushhLoader } from "@/components/app-ui/hushh-loader";
import { AzureCloudReturnPage } from "@/components/connections/azure-cloud-return-page";

export default function OneSetupCloudAzureReturnPage() {
  // Suspense because the return page reads useSearchParams (Microsoft lands
  // here with ?code=...&state=...), and Next requires a boundary around any
  // client search-param read during prerender.
  return (
    <Suspense fallback={<HushhLoader label="Finishing Microsoft sign-in…" />}>
      <AzureCloudReturnPage />
    </Suspense>
  );
}
