"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

import { AppPageShell } from "@/components/app-ui/app-page-shell";
import { HushhLoader } from "@/components/app-ui/hushh-loader";
import { ROUTES } from "@/lib/navigation/routes";

export default function LegacyKaiDashboardRedirect() {
  const router = useRouter();

  useEffect(() => {
    router.replace(ROUTES.KAI_DASHBOARD);
  }, [router]);

  return (
    <AppPageShell
      as="div"
      width="content"
      className="flex min-h-72 items-center justify-center"
      nativeTest={{
        routeId: "/kai/dashboard",
        marker: "native-route-kai-dashboard",
        authState: "authenticated",
        dataState: "redirect-valid",
      }}
    >
      <HushhLoader variant="inline" label="Redirecting to portfolio…" />
    </AppPageShell>
  );
}
