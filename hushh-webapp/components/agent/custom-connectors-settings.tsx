"use client";

import { useEffect, useRef, useState } from "react";
import { Capacitor } from "@capacitor/core";
import { Input } from "@/components/ui/input";
import { Button } from "@/lib/morphy-ux/button";
import { morphyToast } from "@/lib/morphy-ux/morphy";
import { ExternalConnectorService } from "@/lib/services/external-connector-service";
import { loadCustomConnectorConfigurations, saveCustomConnectorConfiguration, removeCustomConnectorConfiguration, type CustomConnectorConfiguration } from "@/lib/connections/custom-connector-configuration";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { snapshotValidatedAuthSessionOwner, isValidatedAuthSessionOwnerCurrent } from "@/lib/auth/session-owner";
import { snapshotVaultSessionEpoch, isVaultSessionEpochCurrent } from "@/lib/vault/session-epoch";

type Access = { userId: string; vaultKey: string; vaultOwnerToken: string };
type SavedConnector = Pick<CustomConnectorConfiguration, "connectorId" | "displayName" | "revision" | "enabled">;

/** Vault-backed definitions only. Saving is never provider authentication or tool approval. */
export function CustomConnectorsSettings({ access }: { access: Access }) {
  const [items, setItems] = useState<SavedConnector[]>([]);
  const [removing, setRemoving] = useState<SavedConnector | null>(null);
  const [catalogs, setCatalogs] = useState<Record<string, Array<{ id: string; name: string; revision: string }>>>({});
  const refreshAbort = useRef<AbortController | null>(null);
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
    inFlight.current = false;
    setBusy(false); setCatalogs({}); setRemoving(null);
    setItems([]); setCredential(""); setName(""); setEndpoint(""); setEditing(false); setStatus("loading");
    void loadCustomConnectorConfigurations(access, true).then(records => {
      if (!current()) return;
      setItems(records.map(({ connectorId, displayName, revision, enabled }) => ({ connectorId, displayName, revision, enabled })));
      setStatus("ready");
    }).catch(() => { if (current()) setStatus("failed"); });
    return () => { active = false; refreshAbort.current?.abort(); };
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
      setItems(previous => [...previous, { connectorId: saved.connectorId, displayName: saved.displayName, revision: saved.revision, enabled: saved.enabled }]);
      setCredential(""); setName(""); setEndpoint(""); setEditing(false);
    })();
    morphyToast.promise(operation, {
      loading: "Saving connector…", success: "Connector settings saved.",
      error: "Could not save. Check the address and keep your vault unlocked.",
    });
    try { await operation; } catch { /* The shared toast owns action errors. */ }
    finally { if (current()) { inFlight.current = false; setBusy(false); } }
  };

  const refresh = async (item: SavedConnector) => {
    if (inFlight.current || !lifetime.current()) return;
    inFlight.current = true; setBusy(true);
    const current = lifetime.current;
    const controller = new AbortController(); refreshAbort.current = controller;
    setCatalogs(previous => { const next = { ...previous }; delete next[item.connectorId]; return next; });
    const operation = (async () => {
      const records = await loadCustomConnectorConfigurations(access, true);
      if (!current()) throw new Error("Session changed.");
      const configuration = records.find(record => record.connectorId === item.connectorId);
      if (!configuration || configuration.revision !== item.revision) throw new Error("Connector changed.");
      const tools = await ExternalConnectorService.refreshMcpCatalog({ vaultOwnerToken: access.vaultOwnerToken, configuration, signal: controller.signal, isEffectCurrent: current });
      if (current()) setCatalogs(previous => ({ ...previous, [item.connectorId]: tools }));
    })();
    morphyToast.promise(operation, { loading: "Refreshing tools…", success: "Tools refreshed.", error: "Could not refresh. Check the connection and try again." });
    try { await operation; } catch { /* Shared toast owns the failure. */ }
    finally { if (current()) { inFlight.current = false; setBusy(false); } }
  };

  const setEnabled = async (item: SavedConnector) => {
    if (inFlight.current || !lifetime.current()) return;
    inFlight.current = true; setBusy(true);
    const current = lifetime.current;
    const operation = (async () => {
      const records = await loadCustomConnectorConfigurations(access, true);
      if (!current()) throw new Error("Session changed.");
      const configuration = records.find(record => record.connectorId === item.connectorId);
      if (!configuration || configuration.revision !== item.revision) throw new Error("Connector changed.");
      const saved = await saveCustomConnectorConfiguration(access, { ...configuration, enabled: !item.enabled },
        { confirmedByUser: true, surface: Capacitor.getPlatform() === "ios" ? "ios" : Capacitor.getPlatform() === "android" ? "android" : "web", source: "connector_settings" }, item.revision, current);
      if (!current()) return;
      setItems(previous => previous.map(record => record.connectorId === item.connectorId ? {
        connectorId: saved.connectorId, displayName: saved.displayName, revision: saved.revision, enabled: saved.enabled,
      } : record));
      setCatalogs(previous => { const next = { ...previous }; delete next[item.connectorId]; return next; });
    })();
    morphyToast.promise(operation, { loading: "Updating connector…", success: item.enabled ? "Connector blocked for new turns." : "Connector enabled. Calls still require review.", error: "Could not update. Reopen connectors and try again." });
    try { await operation; } catch { /* Shared toast owns the failure. */ }
    finally { if (current()) { inFlight.current = false; setBusy(false); } }
  };

  const remove = async () => {
    if (!removing || inFlight.current || !lifetime.current()) return;
    const selected = removing;
    const current = lifetime.current;
    inFlight.current = true; setBusy(true);
    const operation = removeCustomConnectorConfiguration(access, selected.connectorId,
      { confirmedByUser: true, surface: Capacitor.getPlatform() === "ios" ? "ios" : Capacitor.getPlatform() === "android" ? "android" : "web", source: "connector_settings" }, selected.revision, current);
    morphyToast.promise(operation, { loading: "Removing connector…", success: "Saved connector removed.", error: "Could not remove. Reopen connectors and try again." });
    try {
      await operation;
      if (current()) {
        setItems(items => items.filter(item => item.connectorId !== selected.connectorId)); setRemoving(null);
        setCatalogs(previous => { const next = { ...previous }; delete next[selected.connectorId]; return next; });
      }
    } catch { /* Shared toast owns the failure. */ }
    finally { if (current()) { inFlight.current = false; setBusy(false); } }
  };

  return <section aria-label="Custom connectors" className="space-y-3">
    <h3 className="text-sm font-medium text-muted-foreground">Custom connectors</h3>
    {status === "loading" ? <p role="status" className="text-sm">Loading saved connectors…</p> : null}
    {status === "failed" ? <p role="status" className="text-sm">Could not load saved connectors. Close and reopen to retry.</p> : null}
    <ul className="divide-y rounded-2xl bg-foreground/10">{items.map(item => <li key={item.connectorId} className="px-4 py-3">
      <p className="text-sm font-medium">{item.displayName}</p>
      <p className="text-xs text-muted-foreground">{item.enabled ? "Saved · connection not verified" : "Blocked for new turns"}</p>
      <div className="flex flex-wrap gap-2">
        <Button size="standard" variant="none" effect="fade" aria-label={`Refresh tools for ${item.displayName}`} disabled={busy || !item.enabled} onClick={() => void refresh(item)}>Refresh tools</Button>
        <Button size="standard" variant="none" effect="fade" aria-label={`${item.enabled ? "Block" : "Enable"} ${item.displayName}`} disabled={busy} onClick={() => void setEnabled(item)}>{item.enabled ? "Block" : "Enable"}</Button>
        <Button size="standard" variant="none" effect="fade" aria-label={`Remove ${item.displayName}`} disabled={busy} onClick={() => setRemoving(item)}>Remove</Button>
      </div>
      {catalogs[item.connectorId] ? <details className="text-sm"><summary className="min-h-11 cursor-pointer py-3">{catalogs[item.connectorId]?.length} tools · Ask first</summary>
        <ul className="max-h-60 overflow-y-auto">{catalogs[item.connectorId]?.map(tool => <li key={tool.id} className="break-words py-2">{tool.name}</li>)}</ul>
      </details> : null}
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
    <AlertDialog open={Boolean(removing)} onOpenChange={open => { if (!open && !busy) setRemoving(null); }}>
      <AlertDialogContent>
        <AlertDialogHeader><AlertDialogTitle>Remove {removing?.displayName}?</AlertDialogTitle>
          <AlertDialogDescription>This removes its saved settings from your vault. It does not revoke access at the provider or undo completed actions.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter><AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction disabled={busy} onClick={event => { event.preventDefault(); void remove(); }}>Remove connector</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </section>;
}
