import { Suspense } from "react";
import { connection } from "next/server";

import OneLocationCircleInvitePageClient from "./page-client";

const nativeStaticExportToken =
  process.env.ONE_LOCATION_NATIVE_TEST_CIRCLE_INVITE_TOKEN || "native-circle-invite-token";

export async function generateStaticParams(): Promise<Array<{ token: string }>> {
  // Exercise the request boundary during the hosted build. An empty list
  // skips rendering and leaves unseen invite links with a static fallback
  // that fails when the One layout requests a connection at runtime.
  return [
    {
      token:
        process.env.CAPACITOR_BUILD === "true"
          ? nativeStaticExportToken
          : "one-invite-render-probe",
    },
  ];
}

export default async function OneLocationCircleInvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  // Shared web links render per request; native exports retain their fixture.
  if (process.env.CAPACITOR_BUILD !== "true") {
    await connection();
  }
  await params;
  return (
    <Suspense fallback={null}>
      <OneLocationCircleInvitePageClient />
    </Suspense>
  );
}
