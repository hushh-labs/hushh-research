"use client";

import { useEffect, useRef, useState } from "react";
import { Capacitor } from "@capacitor/core";
import { HushhOAuthReturn, isNativeCustomConnectorReturnUri } from "@/lib/capacitor/oauth-return";
import { Input } from "@/components/ui/input";
import { Button } from "@/lib/morphy-ux/button";
import { morphyToast } from "@/lib/morphy-ux/morphy";
import { ExternalConnectorService, McpCatalogAuthenticationError } from "@/lib/services/external-connector-service";
import { loadCustomConnectorSnapshot, saveCustomConnectorConfiguration, removeCustomConnectorConfiguration, removeInvalidCustomConnectorConfiguration, type CustomConnectorConfiguration, type InvalidCustomConnector } from "@/lib/connections/custom-connector-configuration";
import { takeRefreshedMcpCatalog } from "@/lib/connections/custom-mcp-catalog-handoff";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { snapshotValidatedAuthSessionOwner, isValidatedAuthSessionOwnerCurrent } from "@/lib/auth/session-owner";
import { snapshotVaultSessionEpoch, isVaultSessionEpochCurrent } from "@/lib/vault/session-epoch";
import type { CustomConnectorRecoveryReference, DriveChatRecoveryReason } from "@/lib/agent/drive-oauth-chat-recovery";

type Access = { userId: string; vaultKey: string; vaultOwnerToken: string };
type SavedConnector = Pick<CustomConnectorConfiguration, "connectorId" | "displayName" | "revision" | "enabled"> & {
  authenticationKind: CustomConnectorConfiguration["authentication"]["kind"];
  hasOAuthRegistration: boolean;
};
type CatalogTool = { id: string; name: string; revision: string; fingerprint: string; permission: "ask_first" | "blocked" };

function savedConnector(record: CustomConnectorConfiguration): SavedConnector {
  return {
    connectorId: record.connectorId, displayName: record.displayName,
    revision: record.revision, enabled: record.enabled,
    authenticationKind: record.authentication.kind,
    hasOAuthRegistration: Boolean(record.oauthRegistration),
  };
}

/** Vault-backed definitions only. Saving is never provider authentication or tool approval. */
export function CustomConnectorsSettings({ access, onPrepareRecovery }: { access: Access;
  onPrepareRecovery?: (input: { attemptId: string; reason: DriveChatRecoveryReason; customConnector?: CustomConnectorRecoveryReference }) => Promise<"ready" | "busy" | "unavailable">;
}) {
  const [items, setItems] = useState<SavedConnector[]>([]);
  const [removing, setRemoving] = useState<SavedConnector | null>(null);
  const [invalid, setInvalid] = useState<InvalidCustomConnector[]>([]);
  const [removingInvalid, setRemovingInvalid] = useState<InvalidCustomConnector | null>(null);
  const [catalogs, setCatalogs] = useState<Record<string, CatalogTool[]>>({});
  const [authRequired, setAuthRequired] = useState<Record<string, boolean>>({});
  const [checkFailed, setCheckFailed] = useState<Record<string, boolean>>({});
  const refreshAbort = useRef<AbortController | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "failed">("loading");
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [credential, setCredential] = useState("");
  const [oauthIssuer, setOauthIssuer] = useState("");
  const [oauthClientId, setOauthClientId] = useState("");
  const [oauthClientSecret, setOauthClientSecret] = useState("");
  const [oauthAuthMethod, setOauthAuthMethod] = useState<"none" | "client_secret_post" | "client_secret_basic">("none");
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const lifetime = useRef<(() => boolean)>(() => false);

  useEffect(() => {
    let active = true;
    const accessForLoad = { userId: access.userId, vaultKey: access.vaultKey, vaultOwnerToken: access.vaultOwnerToken };
    const owner = snapshotValidatedAuthSessionOwner();
    const epoch = snapshotVaultSessionEpoch();
    const current = () => Boolean(active && owner?.userId === accessForLoad.userId &&
      isValidatedAuthSessionOwnerCurrent(owner) && isVaultSessionEpochCurrent(epoch));
    lifetime.current = current;
    inFlight.current = false;
    setBusy(false); setCatalogs({}); setAuthRequired({}); setCheckFailed({}); setRemoving(null);
    setItems([]); setInvalid([]); setRemovingInvalid(null); setCredential(""); setOauthClientSecret(""); setOauthClientId(""); setOauthIssuer(""); setName(""); setEndpoint(""); setEditing(false); setStatus("loading");
    void loadCustomConnectorSnapshot(accessForLoad, true).then(({ configurations: records, invalid: invalidRecords }) => {
      if (!current()) return;
      setItems(records.map(savedConnector));
      setInvalid(invalidRecords);
      const handoff = takeRefreshedMcpCatalog({ ownerUserId: accessForLoad.userId, vaultEpoch: epoch, configurations: records });
      if (handoff) setCatalogs({ [handoff.connectorId]: handoff.tools });
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
        ...(oauthIssuer || oauthClientId || oauthClientSecret ? { oauthRegistration: {
          issuer: oauthIssuer.trim(), clientId: oauthClientId.trim(),
          ...(oauthAuthMethod !== "none" && oauthClientSecret ? { clientSecret: oauthClientSecret } : {}),
          tokenEndpointAuthMethod: oauthAuthMethod,
        } } : {}),
        authentication: credential ? { kind: "api_key", header: "Authorization", value: credential } : { kind: "none" },
      };
      // A saved definition is not a connection. Verify non-OAuth servers before
      // writing anything to the vault; OAuth registrations remain sign-in pending.
      let discovered: CatalogTool[] | null = null;
      let signInNeeded = Boolean(configuration.oauthRegistration);
      if (!configuration.oauthRegistration) {
        try {
          discovered = await ExternalConnectorService.refreshMcpCatalog({
            vaultOwnerToken: access.vaultOwnerToken, configuration,
            signal: refreshAbort.current?.signal ?? new AbortController().signal,
            isEffectCurrent: current,
          });
          if (!discovered.length) throw new Error("No callable tools found.");
        } catch (error) {
          // A verified 401 is a pending OAuth setup, never a connected state.
          // A rejected supplied credential or any other failure is not saved.
          if (!(error instanceof McpCatalogAuthenticationError) || credential) throw error;
          signInNeeded = true;
        }
      }
      const saved = await saveCustomConnectorConfiguration(access, configuration,
        { confirmedByUser: true, surface: Capacitor.getPlatform() === "ios" ? "ios" : Capacitor.getPlatform() === "android" ? "android" : "web", source: "connector_settings" }, null, current);
      if (!current()) return;
      setItems(previous => [...previous, savedConnector(saved)]);
      if (discovered) setCatalogs(previous => ({ ...previous, [saved.connectorId]: discovered }));
      if (signInNeeded) setAuthRequired(previous => ({ ...previous, [saved.connectorId]: true }));
      setCredential(""); setOauthClientSecret(""); setOauthClientId(""); setOauthIssuer(""); setOauthAuthMethod("none"); setName(""); setEndpoint(""); setEditing(false);
    })();
    morphyToast.promise(operation, {
      loading: "Checking connector…", success: "Connector added.",
      error: "Couldn’t connect. Check the server URL and its access token.",
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
      const records = (await loadCustomConnectorSnapshot(access, true)).configurations;
      if (!current()) throw new Error("Session changed.");
      const configuration = records.find(record => record.connectorId === item.connectorId);
      if (!configuration || configuration.revision !== item.revision) throw new Error("Connector changed.");
      const tools = await ExternalConnectorService.refreshMcpCatalog({ vaultOwnerToken: access.vaultOwnerToken, configuration, signal: controller.signal, isEffectCurrent: current });
      if (current()) {
        setCatalogs(previous => ({ ...previous, [item.connectorId]: tools }));
        setAuthRequired(previous => { const next = { ...previous }; delete next[item.connectorId]; return next; });
        setCheckFailed(previous => { const next = { ...previous }; delete next[item.connectorId]; return next; });
      }
    })();
    morphyToast.promise(operation, { loading: "Refreshing tools…", success: "Tools refreshed.", error: "Could not refresh. Check the connection and try again." });
    try { await operation; } catch (error) {
      if (current() && error instanceof McpCatalogAuthenticationError)
        setAuthRequired(previous => ({ ...previous, [item.connectorId]: true }));
      else if (current()) setCheckFailed(previous => ({ ...previous, [item.connectorId]: true }));
      /* Shared toast owns the failure. */
    }
    finally { if (current()) { inFlight.current = false; setBusy(false); } }
  };

  const connect = async (item: SavedConnector) => {
    if (inFlight.current || !lifetime.current() || !onPrepareRecovery) return;
    inFlight.current = true; setBusy(true);
    const current = lifetime.current;
    const controller = new AbortController(); refreshAbort.current = controller;
    let attemptId: string | undefined;
    const operation = (async () => {
      const records = (await loadCustomConnectorSnapshot(access, true)).configurations;
      if (!current()) throw new Error("Session changed.");
      const configuration = records.find(record => record.connectorId === item.connectorId);
      if (!configuration || !configuration.enabled || configuration.revision !== item.revision) throw new Error("Connector changed.");
      if (configuration.authentication.kind === "api_key") throw new Error("This connector uses a saved credential.");
      const result = await ExternalConnectorService.privateMcpOAuth({
        vaultOwnerToken: access.vaultOwnerToken, connectorId: item.connectorId, operation: "begin",
        payload: { revision: item.revision, endpoint: configuration.endpoint,
          ...(configuration.oauthRegistration ? { registeredClient: configuration.oauthRegistration } : {}) },
        signal: controller.signal, isEffectCurrent: current,
      }) as { attemptId?: unknown; authorizeUrl?: unknown; redirectUri?: unknown };
      if (!result || typeof result.attemptId !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(result.attemptId) || typeof result.authorizeUrl !== "string") throw new Error("Invalid connection response.");
      attemptId = result.attemptId;
      const url = new URL(result.authorizeUrl);
      if (url.protocol !== "https:" || url.username || url.password || url.hash || result.authorizeUrl.length > 16000) throw new Error("Invalid authorization address.");
      if (Capacitor.isNativePlatform() && !isNativeCustomConnectorReturnUri(result.redirectUri)) throw new Error("This connection cannot return to the app.");
      const ready = await onPrepareRecovery({ attemptId, reason: "web_full_page", customConnector: {
        connectorId: item.connectorId, revision: item.revision,
      } });
      if (!current() || ready !== "ready") throw new Error("Finish the current chat action first.");
      // Explicit tap only. The app-owned HTTPS callback resumes the same
      // conversation; no provider credential is handed to the native plugin.
      if (Capacitor.isNativePlatform()) {
        await HushhOAuthReturn.openAuthorization({ authorizeUrl: url.href,
          redirectUri: result.redirectUri as string, attemptId, expectedUserId: access.userId });
      } else window.location.assign(url.href);
    })();
    morphyToast.promise(operation, { loading: "Preparing sign-in…", success: "Continue at your provider.", error: "Could not start sign-in. Check this server supports OAuth and try again." });
    try { await operation; } catch {
      if (attemptId && current()) await ExternalConnectorService.privateMcpOAuth({
        vaultOwnerToken: access.vaultOwnerToken, connectorId: item.connectorId, operation: "cancel",
        payload: { revision: item.revision, attemptId }, signal: controller.signal, isEffectCurrent: current,
      }).catch(() => undefined);
    } finally { if (current()) { inFlight.current = false; setBusy(false); } }
  };

  const setToolBlocked = async (item: SavedConnector, tool: CatalogTool) => {
    if (inFlight.current || !lifetime.current()) return;
    inFlight.current = true; setBusy(true);
    const current = lifetime.current;
    const operation = (async () => {
      const records = (await loadCustomConnectorSnapshot(access, true)).configurations;
      if (!current()) throw new Error("Session changed.");
      const configuration = records.find(record => record.connectorId === item.connectorId);
      if (!configuration || !configuration.enabled || configuration.revision !== item.revision ||
          !catalogs[item.connectorId]?.some(entry => entry.id === tool.id && entry.fingerprint === tool.fingerprint))
        throw new Error("Connector tools changed.");
      const blockedTools = (configuration.blockedTools ?? []).filter(entry => entry.id !== tool.id);
      if (tool.permission !== "blocked") blockedTools.push({ id: tool.id, fingerprint: tool.fingerprint });
      const saved = await saveCustomConnectorConfiguration(access, { ...configuration, blockedTools },
        { confirmedByUser: true, surface: Capacitor.getPlatform() === "ios" ? "ios" : Capacitor.getPlatform() === "android" ? "android" : "web", source: "connector_settings" }, item.revision, current);
      if (!current()) return;
      setItems(previous => previous.map(record => record.connectorId === item.connectorId ? savedConnector(saved) : record));
      setCatalogs(previous => ({ ...previous, [item.connectorId]: (previous[item.connectorId] ?? []).map(entry =>
        entry.id === tool.id ? { ...entry, permission: tool.permission === "blocked" ? "ask_first" : "blocked" } : entry) }));
    })();
    morphyToast.promise(operation, { loading: "Updating tool…", success: tool.permission === "blocked" ? "Tool available for reviewed calls in new turns." : "Tool blocked for new turns.", error: "Could not update the tool. Refresh tools and try again." });
    try { await operation; } catch { /* The shared toast owns action errors. */ }
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
        setAuthRequired(previous => { const next = { ...previous }; delete next[selected.connectorId]; return next; });
      }
    } catch { /* Shared toast owns the failure. */ }
    finally { if (current()) { inFlight.current = false; setBusy(false); } }
  };

  const removeInvalid = async () => {
    if (!removingInvalid || inFlight.current || !lifetime.current()) return;
    const selected = removingInvalid;
    const current = lifetime.current;
    inFlight.current = true; setBusy(true);
    const operation = removeInvalidCustomConnectorConfiguration(access, selected.connectorId,
      { confirmedByUser: true, surface: Capacitor.getPlatform() === "ios" ? "ios" : Capacitor.getPlatform() === "android" ? "android" : "web", source: "connector_settings" }, current);
    morphyToast.promise(operation, { loading: "Removing saved connector…", success: "Saved connector removed.", error: "Could not remove this connector. Reopen connectors and try again." });
    try {
      await operation;
      if (current()) { setInvalid(previous => previous.filter(item => item.connectorId !== selected.connectorId)); setRemovingInvalid(null); }
    } catch { /* Shared toast owns the failure. */ }
    finally { if (current()) { inFlight.current = false; setBusy(false); } }
  };

  return <section aria-label="Custom connectors" className="space-y-3">
    <h3 className="text-sm font-medium text-muted-foreground">Custom connectors</h3>
    {status === "loading" ? <p role="status" className="text-sm">Loading saved connectors…</p> : null}
    {status === "failed" ? <p role="status" className="text-sm">Could not load saved connectors. Close and reopen to retry.</p> : null}
    {invalid.length > 0 ? <div role="status" className="rounded-xl bg-foreground/10 px-3 py-2 text-sm">
      <p>{invalid.length} saved {invalid.length === 1 ? "connector needs" : "connectors need"} repair. Other connectors remain available.</p>
      {invalid.map((item, index) => <div key={item.connectorId} className="flex min-h-11 items-center justify-between gap-3">
        <span>Saved connector {index + 1}</span>
        {item.removable ? <Button size="compact" variant="none" effect="fade" disabled={busy} onClick={() => setRemovingInvalid(item)}>Remove</Button>
          : <span className="text-xs text-muted-foreground">Needs repair</span>}
      </div>)}
    </div> : null}
    <ul className="divide-y rounded-2xl bg-foreground/10">{items.map(item => <li key={item.connectorId} className="px-4 py-3">
      <p className="text-sm font-medium">{item.displayName}</p>
      <p className="text-xs text-muted-foreground">{!item.enabled ? "Blocked for new turns"
        : authRequired[item.connectorId] ? item.authenticationKind === "api_key"
          ? "Saved credential rejected · remove and add again"
          : "Sign in needed"
        : checkFailed[item.connectorId] ? "Connection check failed · verify server address and credential"
        : catalogs[item.connectorId] ? `${catalogs[item.connectorId]?.length ?? 0} tools discovered`
        : item.authenticationKind === "none" ? "Sign in or refresh tools to verify" : "Tools not checked"}</p>
      <div className="flex flex-wrap gap-2">
        {onPrepareRecovery && item.authenticationKind !== "api_key" && (item.hasOAuthRegistration || item.authenticationKind === "oauth" || authRequired[item.connectorId])
          ? <Button size="compact" variant="none" effect="fade" aria-label={`Sign in to ${item.displayName}`} disabled={busy || !item.enabled} onClick={() => void connect(item)}>Sign in</Button> : null}
        <Button size="compact" variant="none" effect="fade" aria-label={`Refresh tools for ${item.displayName}`} disabled={busy || !item.enabled} onClick={() => void refresh(item)}>Refresh tools</Button>
        <Button size="compact" variant="none" effect="fade" aria-label={`Remove ${item.displayName}`} disabled={busy} onClick={() => setRemoving(item)}>Remove</Button>
      </div>
      {catalogs[item.connectorId] ? <details className="text-sm"><summary className="min-h-11 cursor-pointer py-3">{catalogs[item.connectorId]?.length} tools</summary>
        <ul className="max-h-60 overflow-y-auto">{catalogs[item.connectorId]?.map(tool => <li key={tool.id} className="flex min-h-11 items-center justify-between gap-3 border-t py-1">
          <span className="min-w-0 break-words">{tool.name}</span>
          <Button size="compact" variant="none" effect="fade" disabled={busy || !item.enabled}
            aria-label={`${tool.permission === "blocked" ? "Allow reviewed calls to" : "Block"} ${tool.name} in ${item.displayName}`}
            onClick={() => void setToolBlocked(item, tool)}>{tool.permission === "blocked" ? "Blocked · Allow" : "Ask first · Block"}</Button>
        </li>)}</ul>
      </details> : null}
    </li>)}</ul>
    {editing ? <form className="space-y-3" onSubmit={event => { event.preventDefault(); void save(); }}>
      <label className="block space-y-1 text-sm">Name<Input required maxLength={100} value={name} onChange={event => setName(event.target.value)} /></label>
      <label className="block space-y-1 text-sm">Server URL<Input required type="url" placeholder="https://example.com/mcp" value={endpoint} onChange={event => setEndpoint(event.target.value)} /></label>
      <label className="block space-y-1 text-sm">Access token (optional)<Input type="password" autoComplete="off" maxLength={8192} value={credential} onChange={event => setCredential(event.target.value)} /></label>
      <p className="text-xs text-muted-foreground">Use the server endpoint, not its sign-in page. Never use your vault token.</p>
      <details className="text-sm"><summary className="min-h-11 cursor-pointer py-3">OAuth settings</summary>
        <div className="space-y-3 pb-3">
          <label className="block space-y-1">Authorization server issuer<Input type="url" placeholder="https://accounts.example.com" maxLength={2048} value={oauthIssuer} onChange={event => setOauthIssuer(event.target.value)} /></label>
          <label className="block space-y-1">Client ID<Input maxLength={8192} autoComplete="off" value={oauthClientId} onChange={event => setOauthClientId(event.target.value)} /></label>
          <label className="block space-y-1">Token authentication<select className="flex min-h-11 w-full rounded-[var(--app-input-radius)] border border-input bg-background px-3" value={oauthAuthMethod} onChange={event => { const method = event.target.value as typeof oauthAuthMethod; setOauthAuthMethod(method); if (method === "none") setOauthClientSecret(""); }}><option value="none">Public client</option><option value="client_secret_post">Client secret in request</option><option value="client_secret_basic">Client secret in header</option></select></label>
          {oauthAuthMethod !== "none" ? <label className="block space-y-1">Client secret<Input type="password" autoComplete="off" maxLength={8192} value={oauthClientSecret} onChange={event => setOauthClientSecret(event.target.value)} /></label> : null}
        </div>
      </details>
      <p className="text-xs text-muted-foreground">Only add servers you trust. Tools ask before use.</p>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="compact" effect="fade" disabled={busy}>Add</Button>
        <Button type="button" size="compact" variant="none" effect="fade" disabled={busy} onClick={() => { setCredential(""); setOauthClientSecret(""); setOauthClientId(""); setOauthIssuer(""); setOauthAuthMethod("none"); setName(""); setEndpoint(""); setEditing(false); }}>Cancel</Button>
      </div>
    </form> : <Button size="compact" variant="none" effect="fade" disabled={status !== "ready"} onClick={() => setEditing(true)}>Add connector</Button>}
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
    <AlertDialog open={Boolean(removingInvalid)} onOpenChange={open => { if (!open && !busy) setRemovingInvalid(null); }}>
      <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Remove invalid connector?</AlertDialogTitle>
        <AlertDialogDescription>Its saved settings cannot be used. This removes only that connector from your vault; it does not revoke access at the provider.</AlertDialogDescription>
      </AlertDialogHeader><AlertDialogFooter><AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
        <AlertDialogAction disabled={busy} onClick={event => { event.preventDefault(); void removeInvalid(); }}>Remove connector</AlertDialogAction>
      </AlertDialogFooter></AlertDialogContent>
    </AlertDialog>
  </section>;
}
