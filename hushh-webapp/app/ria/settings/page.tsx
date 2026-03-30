"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

import { AppPageShell } from "@/components/app-ui/app-page-shell";
import { HushhLoader } from "@/components/app-ui/hushh-loader";
import { ROUTES } from "@/lib/navigation/routes";

export default function RiaSettingsAliasPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace(ROUTES.PROFILE);
  }, [router]);

  return (
    <AppPageShell as="div" width="content" className="flex min-h-72 items-center justify-center">
      <HushhLoader variant="inline" label="Redirecting to profile…" />
    </AppPageShell>
  );
}
