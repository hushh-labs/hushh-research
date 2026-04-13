import { RiaClientRequestDetail } from "@/components/ria/ria-client-request-detail";

type SearchParamsInput = Record<string, string | string[] | undefined>;

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] || "" : value || "";
}

export default async function RiaClientRequestDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ userId: string; requestId: string }>;
  searchParams?: Promise<SearchParamsInput>;
}) {
  const resolvedParams = await params;
  const resolvedSearchParams = (await searchParams) || {};
  const forceTestProfile = firstParam(resolvedSearchParams.test_profile).trim() === "1";

  return (
    <RiaClientRequestDetail
      clientId={decodeURIComponent(resolvedParams.userId)}
      requestId={decodeURIComponent(resolvedParams.requestId)}
      forceTestProfile={forceTestProfile}
    />
  );
}
