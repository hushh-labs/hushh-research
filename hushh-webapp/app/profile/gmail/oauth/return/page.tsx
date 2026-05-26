import { Suspense } from "react";

import ProfileGmailOAuthReturnPageClient from "./page-client";

type SearchParamValue = string | string[] | undefined;

function firstSearchParam(value: SearchParamValue): string {
  if (Array.isArray(value)) {
    return String(value[0] || "").trim();
  }
  return String(value || "").trim();
}

export default async function ProfileGmailOAuthReturnPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, SearchParamValue>>;
}) {
  const params = searchParams ? await searchParams : {};

  return (
    <Suspense fallback={null}>
      <ProfileGmailOAuthReturnPageClient
        initialCode={firstSearchParam(params.code)}
        initialState={firstSearchParam(params.state)}
        initialError={firstSearchParam(params.error)}
        initialErrorDescription={firstSearchParam(params.error_description)}
      />
    </Suspense>
  );
}
