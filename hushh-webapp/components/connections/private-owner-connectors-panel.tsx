"use client";

import { useState, type ReactNode } from "react";
import { ArrowLeftIcon, XIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import { ConnectorVectorGlyph } from "@/components/agent/connector-brand-mark";
import { PrivateGoogleConnectorsPanel, usePrivateGoogleConnectorsModel } from "@/components/connections/private-google-connectors-panel";
import { PrivatePlaidConnectorGroup, usePrivatePlaidConnectorModel } from "@/components/connections/private-plaid-connector-group";
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
  const plaid = usePrivatePlaidConnectorModel({ open: props.open, access, visitKey: selected });
  const stripe = useStripeConnectorReadiness({ access, onPrepareRecovery: props.onPrepareRecovery });
  const select = (id: string | null) => { if (!props.open) return; setSelection(id); props.onActiveConnectorChange?.(id); };
  if (!props.open) return null;
  const render = (custom: CustomConnectorSettingsModel | null, customBody: ReactNode) => {
    const inDrawer = props.surface !== "profile";
    const entry = google.entries.find(item => item.connector === selected);
    const disabled = !google.enabled || google.busy !== null;
    const webDetailBody = entry ? (
      <section className="space-y-4" data-connector-detail={entry.connector} data-testid={`private-connector-detail-${entry.connector}`}>
        <Button variant="ghost" size="sm" onClick={() => select(null)} className="h-9 gap-1.5 rounded-full px-2.5 text-[13px] font-medium">
          <ArrowLeftIcon className="size-4" aria-hidden="true" />
          <span>All connectors</span>
        </Button>
        <SettingsGroup title={entry.label}>
          <SettingsRow title="Connection" description={entry.status} />
          <SettingsRow title="Purpose" description={entry.purpose} />
          {entry.connected ? (
            <SettingsRow
              title="Background preparation"
              description={entry.backgroundPrep.description}
              trailing={
                entry.backgroundPrep.enabled === null ? undefined : (
                  <Switch
                    aria-label={`${entry.label} background preparation`}
                    checked={entry.backgroundPrep.enabled}
                    disabled={entry.backgroundPrep.busy}
                    onCheckedChange={checked => entry.backgroundPrep.change(checked)}
                  />
                )
              }
            />
          ) : null}
        </SettingsGroup>
        <div className="flex flex-wrap items-center gap-2" data-connector-action-bar="true">
          {entry.allowChanges ? (
            <Button variant="default" size="compact" disabled={disabled} onClick={() => void google.run(entry.connector, false)}>
              Allow changes
            </Button>
          ) : null}
          <Button
            variant={entry.connected ? "outline" : "default"}
            size="compact"
            data-connector-action={entry.connected ? "secondary" : "primary"}
            disabled={disabled}
            onClick={() => void google.run(entry.connector, entry.connected)}
          >
            {google.busy === entry.connector ? "Working…" : entry.connected ? "Disconnect" : "Connect"}
          </Button>
          <Button variant="outline" size="compact" data-connector-action="secondary" disabled={disabled} onClick={() => void google.refresh()}>
            Check connection
          </Button>
        </div>
        {google.message ? <p role="status" className="text-xs text-muted-foreground">{google.message}</p> : null}
      </section>
    ) : selected === "stripe" ? (
      <section className="space-y-4" data-connector-detail="stripe" data-testid="private-connector-detail-stripe">
        <Button variant="ghost" size="sm" onClick={() => select(null)} className="h-9 gap-1.5 rounded-full px-2.5 text-[13px] font-medium">
          <ArrowLeftIcon className="size-4" aria-hidden="true" />
          <span>All connectors</span>
        </Button>
        <StripeConnectorReadiness access={access} onPrepareRecovery={props.onPrepareRecovery} model={stripe} />
      </section>
    ) : null;
    const stripeSummaryDescription = stripe.checking
      ? "Checking connection…"
      : stripe.status === "verified"
        ? "Verified · Account and balance tools ready"
        : stripe.status === "connected"
          ? "Connected · Account tools need verification"
          : "Payouts and optional Stripe tools";
    const webBody = <div className={inDrawer ? "flex h-full min-h-0 flex-col bg-background text-foreground" : "min-w-0 space-y-5"}>
      {inDrawer ? (
        <header className="flex shrink-0 items-center justify-between gap-2 px-4 pb-3 pt-4">
          <h2 className="min-w-0 flex-1 truncate text-lg font-semibold">{entry ? entry.label : selected === "stripe" ? "Stripe" : "Connectors"}</h2>
          <ShellActionSurface
            className="size-11 text-foreground"
            onClick={() => { (props.onClose ?? props.onBack)(); }}
            aria-label="Close connectors"
          >
            <XIcon className="size-[22px]" aria-hidden="true" />
          </ShellActionSurface>
        </header>
      ) : null}
      <div className={inDrawer ? "min-h-0 flex-1 space-y-5 overflow-x-hidden overflow-y-auto overscroll-contain px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))]" : "space-y-5"}>
        {webDetailBody ?? (
          <>
            <PrivateGoogleConnectorsPanel {...props} surface="profile" model={google} onSelectConnector={connector => select(connector)} />
            <PrivatePlaidConnectorGroup model={plaid} showAccessDetails={props.showAccessDetails} />
            <SettingsGroup title="Payments" testId="private-stripe-settings-group">
              <SettingsRow
                testId="private-stripe-row"
                leading={<ConnectorVectorGlyph id="stripe" variant="profile" />}
                title="Stripe"
                description={stripeSummaryDescription}
                onClick={() => select("stripe")}
                chevron
              />
            </SettingsGroup>
            {customBody}
          </>
        )}
      </div>
    </div>;
    if (!props.render) return webBody;
    const entries = [...google.entries.map(entry => ({ id: entry.connector, name: entry.label, detail: entry.status,
      connected: entry.connected, onOpen: () => select(entry.connector) })),
      { id: "plaid", name: "Plaid", detail: plaid.statusLabel, connected: plaid.connected, onOpen: () => select("plaid") },
      { id: "stripe", name: "Stripe", detail: STRIPE_CONNECTION_STATUS[stripe.status], connected: stripe.status === "connected" || stripe.status === "verified", onOpen: () => select("stripe") }]
      .filter(entry => `${entry.name} ${entry.detail}`.toLowerCase().includes(query.toLowerCase()));
    const detail: ConnectorDetailPresentation | null = entry ? { kind: "private-google", status: entry.status, purpose: entry.purpose,
      message: google.message, notes: ["Connect Google directly to Agent One. Your agent asks you to confirm changes."], busy: google.busy !== null,
      background: entry.connected ? entry.backgroundPrep : null,
      actions: [
        ...(entry.allowChanges ? [{ label: "Allow changes", disabled, run: () => { void google.run(entry.connector, false); } }] : []),
        { label: google.busy === entry.connector ? "Working…" : entry.connected ? "Disconnect" : "Connect", disabled,
          destructive: entry.connected, run: () => { void google.run(entry.connector, entry.connected); } },
        { label: "Check connection", disabled, run: () => { void google.refresh(); } },
      ] } : selected === "plaid" ? plaid.detailPresentation
      : selected === "stripe" ? { kind: "private-stripe", status: stripe.checking ? "Checking Stripe tools and Sandbox account…" : STRIPE_CONNECTION_STATUS[stripe.status],
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
    return props.render({ selectedConnector: selected ? { id: selected, name: entry?.label ?? (selected === "plaid" ? "Plaid" : selected === "stripe" ? "Stripe" : "Connector") } : null,
      detail, custom, nativeComplete: !google.handoff,
      catalog: { query, search: value => { if (props.open && value.length <= 256) setQuery(value); }, show: () => select(null),
        status: access ? "ready" : "locked", groups: (["Connected", "Available"] as const).map(title => ({ title, entries: entries.filter(item => item.connected === (title === "Connected")) })),
        retry: async () => { await google.refresh(); return google.isCurrent(); } },
      confirmation: review ? { title: "Replace Google access?", description: `This replaces all Google grants in the affected Google projects. Existing Google connections, including Agent One, will need sign-in again. ${review.services.join(", ")}`,
        action: "Replace and sign in", busy: false, confirm: google.transition.approveTransition, cancel: google.transition.cancelReview } : plaid.confirmation,
      webBody });
  };
  return access ? <CustomConnectorsSettings access={access} onPrepareRecovery={props.onPrepareRecovery} render={render} /> : render(null, null);
}
