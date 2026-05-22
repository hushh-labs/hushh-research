import MarketplaceRiaProfilePageClient from "./page-client";

type SearchParamsInput = Record<string, string | string[] | undefined>;
type MarketplaceRiaProfilePageProps = {
  searchParams?: Promise<SearchParamsInput>;
};

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] || "" : value || "";
}

export default async function MarketplaceRiaProfilePage({
  searchParams,
}: MarketplaceRiaProfilePageProps) {
  const resolvedSearchParams = (await searchParams) || {};
  return (
    <MarketplaceRiaProfilePageClient
      riaId={firstParam(resolvedSearchParams.riaId).trim()}
    />
  );
}
