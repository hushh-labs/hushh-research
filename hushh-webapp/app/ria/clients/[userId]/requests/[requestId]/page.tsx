import { Suspense } from "react";

import RiaClientRequestDetailPageClient from "./page-client";

const nativeStaticExportUserId =
  process.env.REVIEWER_UID ||
  process.env.UAT_SMOKE_USER_ID ||
  process.env.KAI_TEST_USER_ID ||
  "s3xmA4lNSAQFrIaOytnSGAOzXlL2";

export async function generateStaticParams(): Promise<Array<{ userId: string; requestId: string }>> {
  if (process.env.CAPACITOR_BUILD !== "true") {
    return [];
  }
  return [
    {
      userId: nativeStaticExportUserId,
      requestId: "request_demo_kai_specialized_bundle",
    },
  ];
}

export default async function RiaClientRequestDetailPage({
  params,
}: {
  params: Promise<{ userId: string; requestId: string }>;
}) {
  const resolvedParams = await params;

  return (
    <Suspense fallback={null}>
      <RiaClientRequestDetailPageClient
        clientId={decodeURIComponent(resolvedParams.userId)}
        requestId={decodeURIComponent(resolvedParams.requestId)}
      />
    </Suspense>
  );
}
