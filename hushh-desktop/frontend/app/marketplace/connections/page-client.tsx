"use client";

import { useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { buildMarketplaceConnectionsRoute } from "@/lib/navigation/routes";

export default function MarketplaceConnectionsCompatibilityPageClient() {
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    const tabParam = String(searchParams.get("tab") || "").trim();
    const selected = String(searchParams.get("selected") || "").trim() || null;
    router.replace(
      buildMarketplaceConnectionsRoute({
        tab: tabParam === "active" || tabParam === "previous" ? tabParam : "pending",
        selected,
      })
    );
  }, [router, searchParams]);

  return null;
}
