"use client";

import { useSearchParams } from "next/navigation";

import { ClientRedirect } from "@/components/navigation/client-redirect";
import { buildKaiMarketRoute } from "@/lib/navigation/routes";

/** Compatibility surface for existing `/kai` links. */
export default function LegacyKaiMarketPage() {
  const searchParams = useSearchParams();
  return <ClientRedirect to={buildKaiMarketRoute("market", Object.fromEntries(searchParams.entries()))} />;
}
