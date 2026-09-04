"use client";

import { useSearchParams } from "next/navigation";

import { ClientRedirect } from "@/components/navigation/client-redirect";
import { buildKaiMarketRoute } from "@/lib/navigation/routes";

/** Compatibility-only entry. Preserve a legacy tab query while redirecting under One. */
export default function LegacyKaiPage() {
  const searchParams = useSearchParams();
  return (
    <ClientRedirect
      to={buildKaiMarketRoute("market", Object.fromEntries(searchParams.entries()))}
    />
  );
}
