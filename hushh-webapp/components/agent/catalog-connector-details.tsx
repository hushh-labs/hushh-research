"use client";

import { Button } from "@/components/ui/button";
import { StripeConnectorReadiness } from "@/components/agent/stripe-connector-readiness";
import type { CustomConnectorAccess, PrepareRecovery } from "@/lib/connections/custom-connector-setup";
import type { ExternalConnectorSummary } from "@/lib/services/external-connector-service";

type Props = {
  connector: ExternalConnectorSummary; canStartCurated: boolean; loading: boolean;
  busy: boolean; message: string; popupPending: boolean; onCancelSignIn: () => void;
  onConnect: () => void; onDisconnect: () => void; statusLabel: string;
  access: CustomConnectorAccess | null; onPrepareRecovery?: PrepareRecovery;
};

function CuratedActions({ connector, canStartCurated, loading, busy, message,
  popupPending, onCancelSignIn, onConnect, onDisconnect }: Props) {
  return <>
    <div className="flex flex-wrap gap-2">
      {canStartCurated && ["not_connected", "revoked", "needs_reauth", "verifying"].includes(connector.status) &&
        <Button className="min-h-11 min-w-11 whitespace-normal" disabled={busy || loading} onClick={onConnect}>
          {["needs_reauth", "verifying"].includes(connector.status) ? "Reconnect" : "Connect"}
        </Button>}
      {popupPending && <Button className="min-h-11 min-w-11 whitespace-normal" variant="outline" onClick={onCancelSignIn}>
        Cancel sign-in
      </Button>}
      {!["not_connected", "revoked"].includes(connector.status) &&
        <Button className="min-h-11 min-w-11 whitespace-normal" variant="outline" disabled={busy} onClick={onDisconnect}>
          Disconnect
        </Button>}
    </div>
    <p role="status" aria-live="polite" className="text-sm text-muted-foreground">{busy ? "Working…" : message}</p>
  </>;
}

/** Presentation of the current catalog receipt; all actions remain parent-bound. */
export function CatalogConnectorDetails(props: Props) {
  const { connector } = props;
  const status = connector.curatedOAuth === true && !props.canStartCurated &&
    !["not_connected", "revoked"].includes(connector.status)
    ? "Unavailable" : connector.curatedOAuth === true && connector.status === "verifying"
      ? "Sign-in needed" : props.statusLabel;
  return <section className="space-y-3 rounded-xl border border-border p-3" aria-label={`${connector.displayName} details`}>
    <h3 className="font-semibold">{connector.displayName}</h3>
    <p className="text-sm text-muted-foreground">{connector.description}</p>
    {connector.stripeReadiness && <StripeConnectorReadiness
      access={props.access} onPrepareRecovery={props.onPrepareRecovery} />}
    {connector.accountLabel && <p className="break-all text-sm">{connector.accountLabel}</p>}
    {!connector.stripeReadiness && <p role="status" className="text-sm">{status}</p>}
    {connector.curatedOAuth === true && <CuratedActions {...props} />}
  </section>;
}
