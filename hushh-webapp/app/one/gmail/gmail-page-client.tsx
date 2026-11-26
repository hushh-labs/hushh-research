"use client";

import { useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { RouteLoadingState } from "@/components/app-ui/route-loading-state";
import GmailReceiptsPage from "@/components/gmail/gmail-receipts-page";
import { GmailWorkspaceSkeleton } from "@/components/gmail/gmail-workspace-skeleton";
import { CapabilityVaultPrerequisite } from "@/components/vault/capability-vault-prerequisite";
import { gmailDeepLinkWorkspace, ROUTES } from "@/lib/navigation/routes";
import { isOneCapabilityEnabled } from "@/lib/onboarding/one-capabilities";

/**
 * Keep the legacy One Gmail route addressable for existing links, but never
 * mount its workspace while the shared capability registry is paused. Profile
 * remains the recovery and disconnect surface for an already-connected inbox.
 */
export default function OneGmailPageClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const enabled = isOneCapabilityEnabled("gmail");
  // A link opens one tab directly (`/one/gmail?workspace=receipts`). Only the
  // tab name rides in the URL; any prefill for it is handed over in memory.
  const linkedWorkspace = gmailDeepLinkWorkspace(searchParams.get("workspace"));
  // KYC is not a Mail tab. Links written before it moved
  // (`/one/gmail?workspace=kyc`) land on the KYC screen itself, replacing this
  // entry so Back does not return to a link that only forwards.
  const opensKyc = linkedWorkspace === "kyc";
  const feedWorkspace = opensKyc ? undefined : linkedWorkspace;

  useEffect(() => {
    if (!enabled) router.replace(ROUTES.ONE_HOME);
    else if (opensKyc) router.replace(ROUTES.ONE_KYC);
  }, [enabled, opensKyc, router]);

  if (!enabled) return <RouteLoadingState label="Opening One…" />;
  if (opensKyc) return <RouteLoadingState label="Opening KYC…" />;

  return (
    <CapabilityVaultPrerequisite
      capabilityLabel="Mail"
      routeKey={ROUTES.GMAIL}
      checkingFallback={<GmailWorkspaceSkeleton titleVisuallyHidden />}
    >
      <GmailReceiptsPage forceWorkspace={feedWorkspace} />
    </CapabilityVaultPrerequisite>
  );
}
