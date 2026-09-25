"use client";

import { useEffect, useRef, useState } from "react";
import { Capacitor } from "@capacitor/core";
import { Input } from "@/components/ui/input";
import { Button } from "@/lib/morphy-ux/button";
import { morphyToast } from "@/lib/morphy-ux/morphy";
import { loadCustomConnectorConfigurations, saveCustomConnectorConfiguration, type CustomConnectorConfiguration } from "@/lib/connections/custom-connector-configuration";
import { snapshotValidatedAuthSessionOwner, isValidatedAuthSessionOwnerCurrent } from "@/lib/auth/session-owner";
import { snapshotVaultSessionEpoch, isVaultSessionEpochCurrent } from "@/lib/vault/session-epoch";

type Access = { userId: string; vaultKey: string; vaultOwnerToken: string };

/** Vault-backed definitions only. Saving is never provider authentication or tool approval. */
export function CustomConnectorsSettings({ access }: { access: Access }) {
  const [items, setItems] = useState<Array<{ connectorId: string; displayName: string }>>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "failed">("loading");
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [credential, setCredential] = useState("");
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const lifetime = useRef<(() => boolean)>(() => false);

  useEffect(() => {
    let active = true;
    const owner = snapshotValidatedAuthSessionOwner();
    const epoch = snapshotVaultSessionEpoch();
    const current = () => Boolean(active && owner?.userId === access.userId &&
      isValidatedAuthSessionOwnerCurrent(owner) && isVaultSessionEpochCurrent(epoch));
    lifetime.current = current;
    setItems([]); setCredential(""); setEditing(false); setStatus("loading");
    void loadCustomConnectorConfigurations(access, true).then(records => {
      if (!current()) return;
      setItems(records.map(({ connectorId, displayName }) => ({ connectorId, displayName })));
      setStatus("ready");
    }).catch(() => { if (current()) setStatus("failed"); });
    return () => { active = false; };
  }, [access.userId, access.vaultKey, access.vaultOwnerToken]);

  const save = async () => {
    if (inFlight.current || !lifetime.current()) return;
    inFlight.current = true; setBusy(true);
    const current = lifetime.current;
    const operation = (async () => {
      const configuration: CustomConnectorConfiguration = {
        version: 1, connectorId: `custom_${crypto.randomUUID().replaceAll("-", "")}`,
        revision: crypto.randomUUID(), displayName: name.trim(), endpoint: endpoint.trim(), enabled: true,
        authentication: credential ? { kind: "api_key", header: "Authorization", value: credential } : { kind: "none" },
      };
      const saved = await saveCustomConnectorConfiguration(access, configuration,
        { confirmedByUser: true, surface: Capacitor.getPlatform() === "ios" ? "ios" : Capacitor.getPlatform() === "android" ? "android" : "web", source: "connector_settings" }, null, current);
      if (!current()) return;
      setItems(previous => [...previous, { connectorId: saved.connectorId, displayName: saved.displayName }]);
      setCredential(""); setName(""); setEndpoint(""); setEditing(false);
    })();
    morphyToast.promise(operation, {
      loading: "Saving connector…", success: "Connector settings saved.",
      error: "Could not save. Check the address and keep your vault unlocked.",
    });
    try { await operation; } catch { /* The shared toast owns action errors. */ }
    finally { inFlight.current = false; if (current()) setBusy(false); }
  };

  return <section aria-label="Custom connectors" className="space-y-3">
    <h3 className="text-sm font-medium text-muted-foreground">Custom connectors</h3>
    {status === "loading" ? <p role="status" className="text-sm">Loading saved connectors…</p> : null}
    {status === "failed" ? <p role="status" className="text-sm">Could not load saved connectors. Close and reopen to retry.</p> : null}
    <ul className="divide-y rounded-2xl bg-foreground/10">{items.map(item => <li key={item.connectorId} className="px-4 py-3">
      <p className="text-sm font-medium">{item.displayName}</p>
      <p className="text-xs text-muted-foreground">Saved · connection not verified</p>
    </li>)}</ul>
    {editing ? <form className="space-y-3" onSubmit={event => { event.preventDefault(); void save(); }}>
      <label className="block space-y-1 text-sm">Name<Input required maxLength={100} value={name} onChange={event => setName(event.target.value)} /></label>
      <label className="block space-y-1 text-sm">Server address<Input required type="url" placeholder="https://example.com/mcp" value={endpoint} onChange={event => setEndpoint(event.target.value)} /></label>
      <label className="block space-y-1 text-sm">Authorization header (optional)<Input type="password" autoComplete="off" maxLength={8192} value={credential} onChange={event => setCredential(event.target.value)} /></label>
      <p className="text-xs text-muted-foreground">Use a trusted server. Settings are encrypted in your vault. Each tool call requires review; saving does not sign you in.</p>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="standard" effect="fade" disabled={busy}>Save connector</Button>
        <Button type="button" size="standard" variant="none" effect="fade" disabled={busy} onClick={() => { setCredential(""); setEditing(false); }}>Cancel</Button>
      </div>
    </form> : <Button size="standard" variant="none" effect="fade" disabled={status !== "ready"} onClick={() => setEditing(true)}>Add connector</Button>}
  </section>;
}
