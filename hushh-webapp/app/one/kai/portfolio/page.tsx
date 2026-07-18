"use client";

import { ClientRedirect } from "@/components/navigation/client-redirect";
import { buildKaiMarketRoute } from "@/lib/navigation/routes";

/** Legacy Portfolio entry kept only to preserve bookmarked links. */
export default function LegacyKaiPortfolioPage() {
  return <ClientRedirect to={buildKaiMarketRoute("portfolio")} />;
}
