"use client";

import { Suspense, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { RouteSuspenseFallback } from "@/components/system/route-suspense-fallback";
import { ROUTES } from "@/lib/navigation/routes";

/** Preserve legacy deep links while keeping the access manager inside One. */
function LegacyConsentsRedirect() {
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    const query = searchParams.toString();
    router.replace(query ? `${ROUTES.CONSENTS}?${query}` : ROUTES.CONSENTS);
  }, [router, searchParams]);

  return <RouteSuspenseFallback label="Opening access manager…" />;
}

export default function LegacyConsentsPage() {
  return (
    <Suspense fallback={<RouteSuspenseFallback label="Opening access manager…" />}>
      <LegacyConsentsRedirect />
    </Suspense>
  );
}
