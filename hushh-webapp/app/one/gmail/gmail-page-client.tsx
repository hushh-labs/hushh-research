"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

import { RouteLoadingState } from "@/components/app-ui/route-loading-state";
import GmailReceiptsPage from "@/components/gmail/gmail-receipts-page";
import { GmailWorkspaceSkeleton } from "@/components/gmail/gmail-workspace-skeleton";
import { CapabilityVaultPrerequisite } from "@/components/vault/capability-vault-prerequisite";
import { ROUTES } from "@/lib/navigation/routes";
import { isOneCapabilityEnabled } from "@/lib/onboarding/one-capabilities";

/**
 * Keep the legacy One Gmail route addressable for existing links, but never
 * mount its workspace while the shared capability registry is paused. Profile
 * remains the recovery and disconnect surface for an already-connected inbox.
 */
export default function OneGmailPageClient() {
  const router = useRouter();
  const enabled = isOneCapabilityEnabled("gmail");

  useEffect(() => {
    if (!enabled) router.replace(ROUTES.ONE_HOME);
  }, [enabled, router]);

  if (!enabled) return <RouteLoadingState label="Opening One…" />;

  return (
    <CapabilityVaultPrerequisite
      capabilityLabel="Gmail"
      routeKey={ROUTES.GMAIL}
      checkingFallback={<GmailWorkspaceSkeleton />}
    >
      <GmailReceiptsPage />
    </CapabilityVaultPrerequisite>
  );
}
