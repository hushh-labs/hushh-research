import { Suspense } from "react";

import OneLocationCircleInvitePageClient from "./page-client";

const nativeStaticExportToken =
  process.env.ONE_LOCATION_NATIVE_TEST_CIRCLE_INVITE_TOKEN || "native-circle-invite-token";

export async function generateStaticParams(): Promise<Array<{ token: string }>> {
  if (process.env.CAPACITOR_BUILD !== "true") {
    return [];
  }
  return [{ token: nativeStaticExportToken }];
}

export default async function OneLocationCircleInvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  await params;
  return (
    <Suspense fallback={null}>
      <OneLocationCircleInvitePageClient />
    </Suspense>
  );
}
