"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

import { RouteLoadingState } from "@/components/app-ui/route-loading-state";
import GmailReceiptsPage from "@/components/gmail/gmail-receipts-page";
import { CapabilityVaultPrerequisite } from "@/components/vault/capability-vault-prerequisite";
import { ROUTES } from "@/lib/navigation/routes";
import { isOneCapabilityEnabled } from "@/lib/onboarding/one-capabilities";

/**
 * The KYC request-and-review screen. It is its own screen, not a Mail tab: the
 * Feed, setup and every older `/one/gmail?workspace=kyc` link open it here. The
 * requests, drafts and approvals are the existing flow, unchanged; it reuses the
 * one Mail connection because that is where information requests arrive.
 */
export default function OneKycPageClient() {
  const router = useRouter();
  const enabled = isOneCapabilityEnabled("gmail");

  useEffect(() => {
    if (!enabled) router.replace(ROUTES.ONE_HOME);
  }, [enabled, router]);

  if (!enabled) return <RouteLoadingState label="Opening One…" />;

  return (
    <CapabilityVaultPrerequisite capabilityLabel="KYC" routeKey={ROUTES.ONE_KYC}>
      <GmailReceiptsPage surface="kyc" />
    </CapabilityVaultPrerequisite>
  );
}
