import { Suspense } from "react";

import RiaClientAccountDetailPageClient from "./page-client";

const nativeStaticExportUserId =
  process.env.REVIEWER_UID ||
  process.env.UAT_SMOKE_USER_ID ||
  process.env.KAI_TEST_USER_ID ||
  "s3xmA4lNSAQFrIaOytnSGAOzXlL2";

export async function generateStaticParams(): Promise<Array<{ userId: string; accountId: string }>> {
  if (process.env.CAPACITOR_BUILD !== "true") {
    return [];
  }
  return [
    {
      userId: nativeStaticExportUserId,
      accountId: "acct_demo_taxable_main",
    },
  ];
}

export default async function RiaClientAccountDetailPage({
  params,
}: {
  params: Promise<{ userId: string; accountId: string }>;
}) {
  const resolvedParams = await params;

  return (
    <Suspense fallback={null}>
      <RiaClientAccountDetailPageClient
        clientId={decodeURIComponent(resolvedParams.userId)}
        accountId={decodeURIComponent(resolvedParams.accountId)}
      />
    </Suspense>
  );
}
