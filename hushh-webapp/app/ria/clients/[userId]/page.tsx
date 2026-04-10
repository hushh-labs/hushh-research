import { RiaClientWorkspace } from "@/components/ria/ria-client-workspace";

type SearchParamsInput = Record<string, string | string[] | undefined>;

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] || "" : value || "";
}

export default async function RiaClientWorkspacePage({
  params,
  searchParams,
}: {
  params: Promise<{ userId: string }>;
  searchParams?: Promise<SearchParamsInput>;
}) {
  const resolvedParams = await params;
  const resolvedSearchParams = (await searchParams) || {};
  const initialTab = firstParam(resolvedSearchParams.tab).trim();
  const forceTestProfile = firstParam(resolvedSearchParams.test_profile).trim() === "1";
  return (
    <RiaClientWorkspace
      clientId={decodeURIComponent(resolvedParams.userId)}
      forceTestProfile={forceTestProfile}
      initialTab={
        initialTab === "overview" ||
        initialTab === "access" ||
        initialTab === "kai" ||
        initialTab === "explorer"
          ? initialTab
          : "overview"
      }
    />
  );
}
