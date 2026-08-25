import { Suspense } from "react";

import { AppPageShell } from "@/components/app-ui/app-page-shell";

import ReferralLandingPageClient from "./page-client";

const nativeStaticExportSlug =
  process.env.ONE_REFERRAL_NATIVE_TEST_SLUG || "native-test-referral";

export async function generateStaticParams(): Promise<Array<{ slug: string }>> {
  if (process.env.CAPACITOR_BUILD !== "true") {
    return [];
  }
  return [{ slug: nativeStaticExportSlug }];
}

export default async function ReferralLandingPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return (
    <AppPageShell>
      <Suspense fallback={null}>
        <ReferralLandingPageClient slug={slug} />
      </Suspense>
    </AppPageShell>
  );
}
