import MarketplaceRiaProfilePageClient from "./page-client";

type SearchParamsInput = Record<string, string | string[] | undefined>;

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] || "" : value || "";
}

export default function MarketplaceRiaProfilePage({
  searchParams,
}: {
  searchParams?: SearchParamsInput;
}) {
  const resolvedSearchParams = searchParams || {};
  return (
    <MarketplaceRiaProfilePageClient
      riaId={firstParam(resolvedSearchParams.riaId).trim()}
    />
  );
}
