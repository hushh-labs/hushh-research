"use client";

import { useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { legacyProfileRouteRedirectHref } from "@/lib/navigation/profile-pane";

/** The Capacitor bundle's half of the /one/profile redirect; see page.tsx. */
export function ProfileRouteClientRedirect() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const target = legacyProfileRouteRedirectHref(
    new URLSearchParams(searchParams?.toString() ?? ""),
  );
  useEffect(() => {
    router.replace(target);
  }, [router, target]);
  return null;
}
