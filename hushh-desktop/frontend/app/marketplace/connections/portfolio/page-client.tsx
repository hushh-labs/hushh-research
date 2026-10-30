"use client";

import { useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { buildMarketplaceConnectionPortfolioRoute } from "@/lib/navigation/routes";

function firstParam(value: string | string[] | null | undefined): string {
  return Array.isArray(value) ? value[0] || "" : value || "";
}

export default function ConnectionPortfolioCompatibilityPageClient() {
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    const connectionId = firstParam(searchParams.get("connectionId")).trim();
    router.replace(buildMarketplaceConnectionPortfolioRoute(connectionId));
  }, [router, searchParams]);

  return null;
}
