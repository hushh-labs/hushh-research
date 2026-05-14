"use client";

import { Suspense } from "react";
import { useSearchParams, redirect } from "next/navigation";
import { buildMarketplaceConnectionPortfolioRoute } from "@/lib/navigation/routes";

function PortfolioContent() {
  const searchParams = useSearchParams();
  const connectionId = (searchParams.get("connectionId") || "").trim();
  
  if (connectionId) {
    redirect(buildMarketplaceConnectionPortfolioRoute(connectionId));
  }
  
  return null;
}

export default function PortfolioPage() {
  return (
    <Suspense fallback={<div>Loading portfolio...</div>}>
      <PortfolioContent />
    </Suspense>
  );
}