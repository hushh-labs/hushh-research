"use client";

import { PrivateGoogleConnectorsPanel } from "@/components/connections/private-google-connectors-panel";
import { StripeConnectorReadiness } from "@/components/agent/stripe-connector-readiness";
import { CustomConnectorsSettings } from "@/components/agent/custom-connectors-settings";
import { useAuth } from "@/hooks/use-auth";
import { useVault } from "@/lib/vault/vault-context";
import type { PrepareRecovery } from "@/lib/connections/custom-connector-setup";

/** Connector setup stays on the existing owner-vault and pod transport paths. */
export function PrivateOwnerConnectorsPanel(props: {
  open: boolean; onBack: () => void; onClose?: () => void; surface?: "drawer" | "profile";
  onPrepareRecovery?: PrepareRecovery;
}) {
  const { user } = useAuth();
  const { vaultKey, vaultOwnerToken } = useVault();
  if (!props.open) return null;
  const access = user?.uid && vaultKey && vaultOwnerToken
    ? { userId: user.uid, vaultKey, vaultOwnerToken } : null;
  return <div className="space-y-4">
    <PrivateGoogleConnectorsPanel {...props} />
    <StripeConnectorReadiness access={access} onPrepareRecovery={props.onPrepareRecovery} />
    {access && <CustomConnectorsSettings access={access} onPrepareRecovery={props.onPrepareRecovery} />}
  </div>;
}
