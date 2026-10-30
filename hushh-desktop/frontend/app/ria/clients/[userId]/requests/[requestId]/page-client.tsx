"use client";

import { useSearchParams } from "next/navigation";

import { RiaClientRequestDetail } from "@/components/ria/ria-client-request-detail";

export default function RiaClientRequestDetailPageClient({
  clientId,
  requestId,
}: {
  clientId: string;
  requestId: string;
}) {
  const searchParams = useSearchParams();
  const forceTestProfile = (searchParams.get("test_profile") || "").trim() === "1";

  return (
    <RiaClientRequestDetail
      clientId={clientId}
      requestId={requestId}
      forceTestProfile={forceTestProfile}
    />
  );
}
