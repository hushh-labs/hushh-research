import ProfileGmailOAuthReturnPageClient from "./page-client";

type SearchParamsInput = Record<string, string | string[] | undefined>;

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] || "" : value || "";
}

export default function ProfileGmailOAuthReturnPage({
  searchParams,
}: {
  searchParams?: SearchParamsInput;
}) {
  const resolvedSearchParams = searchParams || {};
  return (
    <ProfileGmailOAuthReturnPageClient
      initialCode={firstParam(resolvedSearchParams.code).trim()}
      initialState={firstParam(resolvedSearchParams.state).trim()}
      initialError={firstParam(resolvedSearchParams.error).trim()}
      initialErrorDescription={firstParam(resolvedSearchParams.error_description).trim()}
    />
  );
}
