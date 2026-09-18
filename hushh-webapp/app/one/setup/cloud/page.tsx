import { Suspense } from "react";

import { ByocCloudSetupPage } from "@/components/connections/byoc-cloud-setup-page";

export default function OneSetupCloudPage() {
  // Suspense because the setup page reads useSearchParams (the OAuth return
  // lands back here with ?authorize_error=...), and Next requires a boundary
  // around any client search-param read during prerender.
  return (
    <Suspense fallback={null}>
      <ByocCloudSetupPage />
    </Suspense>
  );
}
