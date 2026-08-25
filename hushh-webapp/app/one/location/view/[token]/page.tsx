import { Suspense } from "react";

import PublicLocationViewPageClient from "./page-client";

const nativeStaticExportToken =
  process.env.ONE_LOCATION_NATIVE_TEST_PUBLIC_TOKEN || "native-test-token";

export async function generateStaticParams(): Promise<Array<{ token: string }>> {
  if (process.env.CAPACITOR_BUILD !== "true") {
    return [];
  }
  return [{ token: nativeStaticExportToken }];
}

export default async function PublicLocationViewPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  await params;
  return (
    <Suspense fallback={null}>
      <PublicLocationViewPageClient />
    </Suspense>
  );
}
