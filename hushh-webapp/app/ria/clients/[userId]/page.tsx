import { Suspense } from "react";

import RiaClientWorkspacePageClient from "./page-client";

const nativeStaticExportUserId =
  process.env.REVIEWER_UID ||
  process.env.UAT_SMOKE_USER_ID ||
  process.env.KAI_TEST_USER_ID ||
  "UWHGeUyfUAbmEl5xwIPoWJ7Cyft2";

export async function generateStaticParams(): Promise<Array<{ userId: string }>> {
  if (process.env.CAPACITOR_BUILD !== "true") {
    return [];
  }
  // The native audit uses a public fixture, never the reviewer's identifier in
  // route reports. This does not make arbitrary dynamic paths available in a
  // static export; product navigation still needs its own native route owner.
  return [...new Set([nativeStaticExportUserId, "native-audit-fixture"])].map(userId => ({ userId }));
}

export default async function RiaClientWorkspacePage({
  params,
}: {
  params: Promise<{ userId: string }>;
}) {
  const resolvedParams = await params;
  return (
    <Suspense fallback={null}>
      <RiaClientWorkspacePageClient clientId={decodeURIComponent(resolvedParams.userId)} />
    </Suspense>
  );
}
