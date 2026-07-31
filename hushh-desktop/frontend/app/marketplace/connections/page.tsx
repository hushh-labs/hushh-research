import { Suspense } from "react";

import MarketplaceConnectionsCompatibilityPageClient from "./page-client";

export default function MarketplaceConnectionsCompatibilityPage() {
  return (
    <Suspense fallback={null}>
      <MarketplaceConnectionsCompatibilityPageClient />
    </Suspense>
  );
}
