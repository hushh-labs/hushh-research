import { Suspense } from "react";
import { connection } from "next/server";

import PublicLocationViewPageClient from "./page-client";

const nativeStaticExportToken =
  process.env.ONE_LOCATION_NATIVE_TEST_PUBLIC_TOKEN || "native-test-token";

export async function generateStaticParams(): Promise<
  Array<{ token: string }>
> {
  // Prerender one inert path so the web build executes connection() and
  // classifies this route as dynamic. An empty list skips that proof and
  // creates an SSG fallback that throws on the first real shared link.
  return [
    {
      token:
        process.env.CAPACITOR_BUILD === "true"
          ? nativeStaticExportToken
          : "public-location-render-probe",
    },
  ];
}

export default async function PublicLocationViewPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  // Native exports render the fixture statically; hosted links render per request.
  if (process.env.CAPACITOR_BUILD !== "true") {
    await connection();
  }
  await params;
  return (
    <Suspense fallback={null}>
      <PublicLocationViewPageClient />
    </Suspense>
  );
}
