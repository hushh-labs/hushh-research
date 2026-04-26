import { redirect } from "next/navigation";

import { buildMarketplaceConnectionsRoute } from "@/lib/navigation/routes";

type SearchParamsInput = Record<string, string | string[] | undefined>;

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] || "" : value || "";
}

export default function MarketplaceConnectionsCompatibilityPage({
  searchParams,
}: {
  searchParams?: SearchParamsInput;
}) {
  const resolvedSearchParams = searchParams || {};
  redirect(
    buildMarketplaceConnectionsRoute({
      tab:
        firstParam(resolvedSearchParams.tab).trim() === "active" ||
        firstParam(resolvedSearchParams.tab).trim() === "previous"
          ? (firstParam(resolvedSearchParams.tab).trim() as "active" | "previous")
          : "pending",
      selected: firstParam(resolvedSearchParams.selected).trim() || null,
    })
  );
}
