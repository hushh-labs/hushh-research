import { Suspense } from "react";

import MarketplaceRiaProfilePageClient from "./page-client";

export default function MarketplaceRiaProfilePage() {
  return (
    <Suspense fallback={null}>
      <MarketplaceRiaProfilePageClient />
    </Suspense>
  );
}
