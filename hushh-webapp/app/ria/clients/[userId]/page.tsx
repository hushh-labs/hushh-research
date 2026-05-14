import { Suspense } from "react";

import RiaClientWorkspacePageClient from "./page-client";

const nativeStaticExportUserId =
  process.env.REVIEWER_UID ||
  process.env.UAT_SMOKE_USER_ID ||
  process.env.KAI_TEST_USER_ID ||
  "s3xmA4lNSAQFrIaOytnSGAOzXlL2";

export async function generateStaticParams(): Promise<Array<{ userId: string }>> {
  if (process.env.CAPACITOR_BUILD !== "true") {
    return [];
  }
  return [{ userId: nativeStaticExportUserId }];
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
