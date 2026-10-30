"use client";

import { useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { buildProfileConnectorsPaneHref } from "@/lib/navigation/profile-pane";

/** The Capacitor bundle's half of the /one/profile/connectors redirect. */
export function ProfileConnectorsClientRedirect() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const target = buildProfileConnectorsPaneHref(
    searchParams?.get("connector") ?? null,
  );
  useEffect(() => {
    router.replace(target);
  }, [router, target]);
  return null;
}
