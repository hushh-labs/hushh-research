import { RiaClientAccountDetail } from "@/components/ria/ria-client-account-detail";

type SearchParamsInput = Record<string, string | string[] | undefined>;

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] || "" : value || "";
}

export default async function RiaClientAccountDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ userId: string; accountId: string }>;
  searchParams?: Promise<SearchParamsInput>;
}) {
  const resolvedParams = await params;
  const resolvedSearchParams = (await searchParams) || {};
  const forceTestProfile = firstParam(resolvedSearchParams.test_profile).trim() === "1";

  return (
    <RiaClientAccountDetail
      clientId={decodeURIComponent(resolvedParams.userId)}
      accountId={decodeURIComponent(resolvedParams.accountId)}
      forceTestProfile={forceTestProfile}
    />
  );
}
