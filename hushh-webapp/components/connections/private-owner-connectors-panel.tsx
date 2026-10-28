"use client";

import { useState, type ReactNode } from "react";
import { PrivateGoogleConnectorsPanel, usePrivateGoogleConnectorsModel } from "@/components/connections/private-google-connectors-panel";
import { StripeConnectorReadiness, useStripeConnectorReadiness, STRIPE_CONNECTION_STATUS } from "@/components/agent/stripe-connector-readiness";
import { CustomConnectorsSettings } from "@/components/agent/custom-connectors-settings";
import type { CustomConnectorSettingsModel } from "@/components/agent/custom-connectors-settings";
import type { ConnectorsPanelPresentation, ConnectorDetailPresentation } from "@/components/agent/connectors-panel";
import { useAuth } from "@/hooks/use-auth";
import { useVault } from "@/lib/vault/vault-context";
import type { PrepareRecovery } from "@/lib/connections/custom-connector-setup";
import { openProfilePane } from "@/lib/navigation/profile-pane";

/** Connector setup stays on the existing owner-vault and pod transport paths. */
export function PrivateOwnerConnectorsPanel(props: {
  open: boolean; onBack: () => void; onClose?: () => void; surface?: "drawer" | "profile";
  onPrepareRecovery?: PrepareRecovery;
  showAccessDetails?: boolean;
  activeConnector?: string | null; onActiveConnectorChange?: (id: string | null) => void;
  render?: (model: ConnectorsPanelPresentation) => ReactNode;
}) {
  const { userId } = useAuth();
  const { vaultKey, vaultOwnerToken } = useVault();
  const access = props.open && userId && vaultKey && vaultOwnerToken
    ? { userId, vaultKey, vaultOwnerToken } : null;
  const [query, setQuery] = useState("");
  const [localSelection, setSelection] = useState<string | null>(null);
  const selected = props.activeConnector !== undefined ? props.activeConnector : localSelection;
  const google = usePrivateGoogleConnectorsModel({ open: props.open, visitKey: selected });
  const stripe = useStripeConnectorReadiness({ access, onPrepareRecovery: props.onPrepareRecovery });
  const select = (id: string | null) => { if (!props.open) return; setSelection(id); props.onActiveConnectorChange?.(id); };
  if (!props.open) return null;
  const render = (custom: CustomConnectorSettingsModel | null, customBody: ReactNode) => {
    const webBody = <div className="space-y-4">
      <PrivateGoogleConnectorsPanel {...props} model={google} />
      <StripeConnectorReadiness access={access} onPrepareRecovery={props.onPrepareRecovery} model={stripe} />
      {customBody}
    </div>;
    if (!props.render) return webBody;
    const entries = [...google.entries.map(entry => ({ id: entry.connector, name: entry.label, detail: entry.status,
      connected: entry.connected, onOpen: () => select(entry.connector) })),
      { id: "stripe", name: "Stripe", detail: STRIPE_CONNECTION_STATUS[stripe.status], connected: stripe.status === "connected" || stripe.status === "verified", onOpen: () => select("stripe") }]
      .filter(entry => `${entry.name} ${entry.detail}`.toLowerCase().includes(query.toLowerCase()));
    const entry = google.entries.find(item => item.connector === selected);
    const disabled = !google.enabled || google.busy !== null;
    const detail: ConnectorDetailPresentation | null = entry ? { kind: "private-google", status: entry.status, purpose: entry.purpose,
      message: google.message, notes: ["Connect Google directly to your private agent. Your agent asks you to confirm changes."], busy: google.busy !== null,
      actions: [
        ...(entry.allowChanges ? [{ label: "Allow changes", disabled, run: () => { void google.run(entry.connector, false); } }] : []),
        { label: google.busy === entry.connector ? "Working…" : entry.connected ? "Disconnect" : "Connect", disabled,
          destructive: entry.connected, run: () => { void google.run(entry.connector, entry.connected); } },
        { label: "Check connection", disabled, run: () => { void google.refresh(); } },
      ] } : selected === "stripe" ? { kind: "private-stripe", status: stripe.checking ? "Checking Stripe tools and Sandbox account…" : STRIPE_CONNECTION_STATUS[stripe.status],
      purpose: "Use Payments and earnings to fund purchases and receive earnings. Stripe tool sign-in is optional for sharing.", message: "", busy: stripe.busy || stripe.checking,
      notes: ["Enable MCP access in your Stripe Sandbox, then sign in and select that Sandbox.",
        ...(stripe.status !== "verified" ? ["Stripe account and balance tools still need verification."] : []),
        ...(stripe.verification?.verifiedAt ? [`Provider observation: ${new Date(stripe.verification.verifiedAt).toLocaleString()}. Purchases still require Consent review.`] : [])],
      actions: [
        { label: "Open payments and earnings", disabled: false, run: () => openProfilePane(window.location.pathname, window.location.search, { panel: "payouts", detail: null }, { returnsToOrigin: true }) },
        { label: "Connect or reconnect Stripe tools", disabled: !access || !props.onPrepareRecovery || stripe.busy || stripe.checking, run: () => { void stripe.connect(); } },
        { label: "Check connection", disabled: !access || stripe.busy || stripe.checking, run: () => { void stripe.check(); } },
      ] } : null;
    const review = google.transition.review;
    return props.render({ selectedConnector: selected ? { id: selected, name: entry?.label ?? (selected === "stripe" ? "Stripe" : "Connector") } : null,
      detail, custom, nativeComplete: !google.handoff,
      catalog: { query, search: value => { if (props.open && value.length <= 256) setQuery(value); }, show: () => select(null),
        status: access ? "ready" : "locked", groups: (["Connected", "Available"] as const).map(title => ({ title, entries: entries.filter(item => item.connected === (title === "Connected")) })),
        retry: async () => { await google.refresh(); return google.isCurrent(); } },
      confirmation: review ? { title: "Replace Google access?", description: `This replaces all Google grants in the affected Google projects. Existing Google connections, including your private agent, will need sign-in again. ${review.services.join(", ")}`,
        action: "Replace and sign in", busy: false, confirm: google.transition.approveTransition, cancel: google.transition.cancelReview } : null,
      webBody });
  };
  return access ? <CustomConnectorsSettings access={access} onPrepareRecovery={props.onPrepareRecovery} render={render} /> : render(null, null);
}
