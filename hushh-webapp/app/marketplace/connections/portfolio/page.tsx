import ConnectionPortfolioPageClient from "./page-client";

type SearchParamsInput = Record<string, string | string[] | undefined>;

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] || "" : value || "";
}

export default function ConnectionPortfolioPage({
  searchParams,
}: {
  searchParams?: SearchParamsInput;
}) {
  const resolvedSearchParams = searchParams || {};
  return (
    <ConnectionPortfolioPageClient
      connectionId={firstParam(resolvedSearchParams.connectionId).trim()}
    />
  );
}
