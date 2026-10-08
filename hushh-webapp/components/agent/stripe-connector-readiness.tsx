"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { morphyToast } from "@/lib/morphy-ux/morphy";
import { isValidatedAuthSessionOwnerCurrent, snapshotValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { loadCustomConnectorSnapshot } from "@/lib/connections/custom-connector-configuration";
import {
  beginCustomConnectorSignIn, connectorSurface, ConnectorSetupError,
  newCustomConnectorConfiguration, verifyAndSaveCustomConnector,
  type CustomConnectorAccess, type PrepareRecovery,
} from "@/lib/connections/custom-connector-setup";
import { ExternalConnectorService, McpCatalogAuthenticationError, type StripeConnectorReadiness as StripeReadiness } from "@/lib/services/external-connector-service";
import { subscribeToPkmDomainChanges } from "@/lib/pkm/pkm-domain-change-events";
import { isVaultSessionEpochCurrent, snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { ROUTES } from "@/lib/navigation/routes";

const ENDPOINT = "https://mcp.stripe.com";
type ConnectionStatus = "unchecked" | "saved" | "connected" | "verified" | "sign_in_needed" | "unavailable";
const STATUS: Record<ConnectionStatus, string> = {
  unchecked: "Connect or check Stripe documentation tools.",
  saved: "Stripe sign-in saved. Check connection to verify documentation tools.",
  connected: "Documentation tools connected.",
  verified: "Sandbox account and balance tools verified.",
  sign_in_needed: "Sign in to Stripe to connect documentation tools.",
  unavailable: "Documentation tools could not be verified. Check connection or sign in again.",
};

function isStripeEndpoint(endpoint: string): boolean {
  try { const url = new URL(endpoint); return url.protocol === "https:" && url.hostname.replace(/\.+$/, "") === "mcp.stripe.com"; }
  catch { return false; }
}

/** Explicit owner sign-in; selected Stripe account/environment are still unverified. */
export function StripeConnectorReadiness({ access, onPrepareRecovery }: {
  access: CustomConnectorAccess | null;
  onPrepareRecovery?: PrepareRecovery;
}) {
  const lifetime = useRef<() => boolean>(() => false);
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [status, setStatus] = useState<ConnectionStatus>("unchecked");
  const [verification, setVerification] = useState<StripeReadiness | null>(null);
  const checkingAbort = useRef<AbortController | null>(null);
  const statusRevision = useRef(0);
  const userId = access?.userId, vaultKey = access?.vaultKey, vaultOwnerToken = access?.vaultOwnerToken;
  useEffect(() => {
    let active = true;
    const owner = snapshotValidatedAuthSessionOwner(), epoch = snapshotVaultSessionEpoch();
    lifetime.current = () => Boolean(active && owner && owner.userId === userId &&
      isValidatedAuthSessionOwnerCurrent(owner) && isVaultSessionEpochCurrent(epoch));
    inFlight.current = false; setBusy(false); setChecking(false); setStatus("unchecked"); setVerification(null);
    const current = lifetime.current;
    const revision = ++statusRevision.current;
    if (userId && vaultKey && vaultOwnerToken && current()) {
      // Saving sign-in is not a verified catalog. Leave the OAuth return's
      // one-shot tools handoff available to the existing custom settings panel.
      void loadCustomConnectorSnapshot({ userId, vaultKey, vaultOwnerToken }, true).then(({ configurations }) => {
        if (current() && revision === statusRevision.current && configurations.some(record => record.enabled && isStripeEndpoint(record.endpoint) &&
          record.authentication.kind === "oauth")) setStatus("saved");
      }).catch(() => { if (current() && revision === statusRevision.current) setStatus("unavailable"); });
    }
    const invalidate = () => {
      if (!current()) return;
      statusRevision.current += 1;
      checkingAbort.current?.abort();
      setStatus("unchecked");
      setVerification(null);
    };
    const unsubscribe = subscribeToPkmDomainChanges(detail => {
      if (detail.userId === userId && detail.domain === "runtime_secrets") invalidate();
    });
    const onFocus = invalidate;
    window.addEventListener("focus", onFocus);
    return () => { active = false; checkingAbort.current?.abort(); unsubscribe(); window.removeEventListener("focus", onFocus); };
  }, [userId, vaultKey, vaultOwnerToken]);

  const check = async () => {
    if (!access || inFlight.current || !lifetime.current()) return;
    const sessionCurrent = lifetime.current, controller = new AbortController();
    const revision = ++statusRevision.current;
    const current = () => sessionCurrent() && !controller.signal.aborted && revision === statusRevision.current;
    checkingAbort.current = controller;
    inFlight.current = true; setChecking(true); setStatus("unchecked"); setVerification(null);
    try {
      const { configurations } = await loadCustomConnectorSnapshot(access, true);
      if (!current()) return;
      const configuration = configurations.find(record => record.enabled && isStripeEndpoint(record.endpoint));
      if (!configuration || configuration.authentication.kind !== "oauth") { setStatus("sign_in_needed"); return; }
      const tools = await ExternalConnectorService.refreshMcpCatalog({ vaultOwnerToken: access.vaultOwnerToken,
        configuration, signal: controller.signal, isEffectCurrent: current });
      if (!current()) return;
      const latest = await loadCustomConnectorSnapshot(access, true);
      if (!current()) return;
      const unchanged = latest.configurations.some(record => record.enabled &&
        record.connectorId === configuration.connectorId && record.revision === configuration.revision &&
        isStripeEndpoint(record.endpoint) && record.authentication.kind === "oauth");
      if (!unchanged || tools.length === 0) { setStatus("unavailable"); return; }
      setStatus("connected");
      const proof = await ExternalConnectorService.verifyStripeAccount({
        vaultOwnerToken: access.vaultOwnerToken, configuration, signal: controller.signal, isEffectCurrent: current,
      });
      if (!current()) return;
      const after = await loadCustomConnectorSnapshot(access, true);
      if (!current()) return;
      const stillCurrent = after.configurations.some(record => record.enabled && record.connectorId === configuration.connectorId &&
        record.revision === configuration.revision && isStripeEndpoint(record.endpoint) && record.authentication.kind === "oauth");
      if (!stillCurrent) { setStatus("unavailable"); return; }
      setVerification(proof); setStatus(proof.accountToolsAvailable ? "verified" : "connected");
    } catch (error) {
      if (current()) setStatus(error instanceof McpCatalogAuthenticationError ? "sign_in_needed" : "unavailable");
    } finally {
      if (sessionCurrent() && checkingAbort.current === controller) {
        checkingAbort.current = null; inFlight.current = false; setChecking(false);
      }
    }
  };

  const connect = async () => {
    if (!access || !onPrepareRecovery || inFlight.current || !lifetime.current()) return;
    const current = lifetime.current, signal = new AbortController().signal;
    statusRevision.current += 1; setStatus("unchecked"); setVerification(null);
    inFlight.current = true; setBusy(true);
    const operation = (async () => {
      const { configurations } = await loadCustomConnectorSnapshot(access, true);
      if (!current()) return;
      let configuration = configurations.find(record => isStripeEndpoint(record.endpoint));
      if (configuration?.authentication.kind === "api_key")
        throw new ConnectorSetupError("Remove the saved Stripe credential below, then connect with sign-in.");
      if (!configuration) {
        const added = await verifyAndSaveCustomConnector({ access,
          configuration: newCustomConnectorConfiguration({ displayName: "Stripe", endpoint: ENDPOINT }),
          confirmation: { confirmedByUser: true, surface: connectorSurface(), source: "connector_settings" },
          signal, isCurrent: current,
        });
        configuration = added.configuration;
      }
      if (!current()) return;
      await beginCustomConnectorSignIn({ access, configuration, prepareRecovery: onPrepareRecovery, signal, isCurrent: current });
    })();
    morphyToast.promise(operation, { loading: "Opening Stripe sign-in…", success: "Stripe sign-in opened.",
      error: error => error instanceof ConnectorSetupError ? error.message : "Stripe sign-in could not start. Try again." });
    try { await operation; } catch { /* The shared toast owns the action error. */ }
    finally { if (current()) { inFlight.current = false; setBusy(false); } }
  };

  return <section className="space-y-3" aria-label="Stripe connection readiness">
    <p role="status" className="text-sm text-muted-foreground">
      {checking && lifetime.current() ? "Checking Stripe tools and Sandbox account…" : STATUS[lifetime.current() ? status : "unchecked"]}
      {" "}{status !== "verified" && "Stripe account and balance tools still need verification."}
    </p>
    {status === "verified" && lifetime.current() && verification?.verifiedAt && <p className="text-sm text-muted-foreground">
      Provider observation: {new Date(verification.verifiedAt).toLocaleString()}. Payments still use Account and Consent review.
    </p>}
    <p className="text-sm text-muted-foreground">Use Account to fund purchases and set up earnings payouts. Stripe tool sign-in is optional for sharing.</p>
    <p className="text-sm text-muted-foreground">Enable MCP access in your Stripe Sandbox, then sign in and select that Sandbox.</p>
    <div className="flex flex-wrap gap-2">
      <Button asChild variant="outline" className="min-h-11">
        <Link href={ROUTES.PROFILE_ACCOUNT}>Open payments and earnings</Link>
      </Button>
      <Button variant="outline" className="min-h-11" disabled={!access || !onPrepareRecovery || busy || checking} onClick={() => void connect()}>
        {busy ? "Opening Stripe…" : "Connect or reconnect Stripe tools"}
      </Button>
      <Button variant="outline" className="min-h-11" disabled={!access || busy || checking} onClick={() => void check()}>
        {checking ? "Checking…" : "Check connection"}
      </Button>
    </div>
    {!access && <p className="text-sm text-muted-foreground">Sign in and unlock your vault to connect Stripe.</p>}
    {access && !onPrepareRecovery && <p className="text-sm text-muted-foreground">Open Connections from your profile to start Stripe sign-in.</p>}
  </section>;
}
