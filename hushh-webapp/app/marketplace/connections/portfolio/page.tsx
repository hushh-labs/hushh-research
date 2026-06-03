import { Suspense } from "react";

import ConnectionPortfolioCompatibilityPageClient from "./page-client";

export default function ConnectionPortfolioCompatibilityPage() {
  return (
    <Suspense fallback={null}>
      <ConnectionPortfolioCompatibilityPageClient />
    </Suspense>
  );
}
