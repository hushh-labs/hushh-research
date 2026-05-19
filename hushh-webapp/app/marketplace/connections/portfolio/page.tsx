import { redirect } from "next/navigation";
import { buildMarketplaceConnectionPortfolioRoute } from "@/lib/navigation/routes";

type Props = {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

function firstParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] || "" : value || "";
}

export default async function ConnectionPortfolioCompatibilityPage({
  searchParams,
}: Props) {
  // Await the searchParams promise (Next.js 15 requirement)
  const resolvedParams = await searchParams;

  // Safely extract and trim the connectionId
  const connectionId = firstParam(resolvedParams?.connectionId).trim();

  // Execute the redirect
  redirect(buildMarketplaceConnectionPortfolioRoute(connectionId));
}