import { Suspense } from "react";

import { ConsentCenterPage } from "@/components/consent/consent-center-page";
import { HushhLoader } from "@/components/app-ui/hushh-loader";

export default function ConsentsPage() {
  return (
    <Suspense fallback={<HushhLoader variant="inline" label="Loading consents…" />}>
      <ConsentCenterPage />
    </Suspense>
  );
}
