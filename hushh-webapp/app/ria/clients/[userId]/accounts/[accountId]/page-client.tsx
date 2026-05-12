"use client";

import { useSearchParams } from "next/navigation";

import { RiaClientAccountDetail } from "@/components/ria/ria-client-account-detail";

export default function RiaClientAccountDetailPageClient({
  clientId,
  accountId,
}: {
  clientId: string;
  accountId: string;
}) {
  const searchParams = useSearchParams();
  const forceTestProfile = (searchParams.get("test_profile") || "").trim() === "1";

  return (
    <RiaClientAccountDetail
      clientId={clientId}
      accountId={accountId}
      forceTestProfile={forceTestProfile}
    />
  );
}
