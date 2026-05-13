import { redirect } from "next/navigation";

import { buildMarketplaceConnectionPortfolioRoute } from "@/lib/navigation/routes";

type SearchParamsInput = Record<string, string | string[] | undefined>;

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] || "" : value || "";
}

export default function ConnectionPortfolioCompatibilityPage({
  searchParams,
}: {
  searchParams?: SearchParamsInput;
}) {
  const connectionId = firstParam(searchParams?.connectionId).trim();
  redirect(buildMarketplaceConnectionPortfolioRoute(connectionId));
}
