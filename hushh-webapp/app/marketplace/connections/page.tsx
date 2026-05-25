import { redirect } from "next/navigation";

import { buildMarketplaceConnectionsRoute } from "@/lib/navigation/routes";

type SearchParamsInput = Record<string, string | string[] | undefined>;

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] || "" : value || "";
}

export default async function MarketplaceConnectionsCompatibilityPage({
  searchParams,
}: {
  searchParams?: Promise<SearchParamsInput>;
}) {
  const resolvedSearchParams = (await searchParams) || {};
  const tabParam = firstParam(resolvedSearchParams.tab).trim();
  redirect(
    buildMarketplaceConnectionsRoute({
      tab: tabParam === "active" || tabParam === "previous" ? tabParam : "pending",
      selected: firstParam(resolvedSearchParams.selected).trim() || null,
    })
  );
}
