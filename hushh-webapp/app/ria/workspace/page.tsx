import { redirect } from "next/navigation";

import { buildRiaClientWorkspaceRoute, ROUTES } from "@/lib/navigation/routes";

type SearchParamsInput = Record<string, string | string[] | undefined>;

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] || "" : value || "";
}

export default async function RiaWorkspaceCompatibilityPage({
  searchParams,
}: {
  searchParams?: Promise<SearchParamsInput>;
}) {
  const resolvedSearchParams = (await searchParams) || {};
  const clientId = firstParam(resolvedSearchParams.clientId).trim();
  const tab = firstParam(resolvedSearchParams.tab).trim();
  const testProfile = firstParam(resolvedSearchParams.test_profile).trim() === "1";

  if (!clientId) {
    redirect(ROUTES.RIA_CLIENTS);
  }

  redirect(
    buildRiaClientWorkspaceRoute(clientId, {
      tab:
        tab === "overview" || tab === "access" || tab === "kai" || tab === "explorer"
          ? tab
          : undefined,
      testProfile,
    })
  );
}
