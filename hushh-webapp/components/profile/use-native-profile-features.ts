"use client";

import { useLayoutEffect, useState } from "react";
import type { ConnectorsPanelPresentation } from "@/components/agent/connectors-panel";
import type { ProfilePanel } from "@/lib/navigation/profile-routes";
import { useAgentSettingsController } from "./use-agent-settings-controller";
import { useNativeAgentSettings } from "./use-native-agent-settings";
import { useNativeConnectors } from "./use-native-connectors";
import { useNativePayments } from "./use-native-payments";

/** Admission and shared feature lifetimes only. Profile retains routing/Back;
 * feature controllers retain validation and operation authority. */
export function useNativeProfileFeatures({ panel, native, open, secure, owner, userId, connectors }: {
  panel: ProfilePanel | null; native: boolean; open: boolean; secure: boolean;
  owner: string; userId: string | null; connectors: ConnectorsPanelPresentation | undefined;
}) {
  const [connectorsAvailable, setNativeConnectorsAvailable] = useState(false);
  const [paymentsAvailable, setNativePaymentsAvailable] = useState(false);
  const [paymentsFailed, setNativePaymentsFailed] = useState(false);
  const agentSettingsActive = (panel === "hosting" || panel === "software-updates") && (!native || open) && secure;
  const agentSettings = useAgentSettingsController({ kind: panel === "hosting" ? "hosting" : "software-updates", userId, enabled: agentSettingsActive });
  const nativeAgentSettings = useNativeAgentSettings(agentSettings, agentSettingsActive, owner);
  const connectorsWanted = native && open && connectorsAvailable && panel === "connectors" && secure;
  const nativeConnectors = useNativeConnectors(connectors, owner, connectorsWanted);
  const nativeConnectorsActive = connectorsWanted && (!connectors || nativeConnectors.mapped) && !nativeConnectors.failed;
  const paymentsEnabled = panel === "payouts" && secure && (!native || open);
  const nativePayoutActive = native && paymentsEnabled && paymentsAvailable && !paymentsFailed;
  const nativePayout = useNativePayments(paymentsEnabled, nativePayoutActive, owner);
  useLayoutEffect(() => { if (!open || panel !== "payouts") setNativePaymentsFailed(false); }, [open, panel]);
  return { agentSettingsActive, agentSettings, nativeAgentSettings, nativeConnectors, nativeConnectorsActive,
    setNativeConnectorsAvailable, nativePayoutActive, nativePayout, setNativePaymentsAvailable, setNativePaymentsFailed };
}
