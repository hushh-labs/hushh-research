import MarketplaceConnectionsPageClient from "./page-client";

type SearchParamsInput = Record<string, string | string[] | undefined>;

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] || "" : value || "";
}

export default function MarketplaceConnectionsPage({
  searchParams,
}: {
  searchParams?: SearchParamsInput;
}) {
  const resolvedSearchParams = searchParams || {};
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(resolvedSearchParams)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item) params.append(key, item);
      }
      continue;
    }
    if (value) params.set(key, value);
  }

  return (
    <MarketplaceConnectionsPageClient
      initialSearchParams={params.toString()}
      initialSelectedId={firstParam(resolvedSearchParams.selected).trim()}
    />
  );
}
