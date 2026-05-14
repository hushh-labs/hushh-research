import { DebateDashboardView } from "@/components/kai/views/debate-dashboard-view";

export default async function DebatePage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const resolvedParams = await searchParams;
  const ticker = typeof resolvedParams.ticker === "string" ? resolvedParams.ticker : "AAPL";

  return (
    <div className="min-h-screen bg-background">
      <DebateDashboardView ticker={ticker} />
    </div>
  );
}
