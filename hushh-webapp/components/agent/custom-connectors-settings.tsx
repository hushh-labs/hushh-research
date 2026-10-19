"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Capacitor } from "@capacitor/core";
import { Input } from "@/components/ui/input";
import { Button } from "@/lib/morphy-ux/button";
import { morphyToast } from "@/lib/morphy-ux/morphy";
import { ExternalConnectorService, McpCatalogAuthenticationError } from "@/lib/services/external-connector-service";
import { loadCustomConnectorSnapshot, saveCustomConnectorConfiguration, removeCustomConnectorConfiguration, removeInvalidCustomConnectorConfiguration, type CustomConnectorConfiguration, type InvalidCustomConnector } from "@/lib/connections/custom-connector-configuration";
import { beginCustomConnectorSignIn, ConnectorSetupError, newCustomConnectorConfiguration, verifyAndSaveCustomConnector } from "@/lib/connections/custom-connector-setup";
import { takeRefreshedMcpCatalog } from "@/lib/connections/custom-mcp-catalog-handoff";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { snapshotValidatedAuthSessionOwner, isValidatedAuthSessionOwnerCurrent } from "@/lib/auth/session-owner";
import { snapshotVaultSessionEpoch, isVaultSessionEpochCurrent } from "@/lib/vault/session-epoch";
import type { CustomConnectorRecoveryReference, DriveChatRecoveryReason } from "@/lib/agent/drive-oauth-chat-recovery";

type Access = { userId: string; vaultKey: string; vaultOwnerToken: string };
type CatalogTool = { id: string; name: string; revision: string; fingerprint: string; permission: "ask_first" | "blocked"; review?: "required" | "not_required"; access?: "read" | "write" };
type SavedConnector = Pick<CustomConnectorConfiguration, "connectorId" | "displayName" | "revision" | "enabled"> & {
  authenticationKind: CustomConnectorConfiguration["authentication"]["kind"];
  hasOAuthRegistration: boolean;
};
export type CustomConnectorDraft = {
  name: string; endpoint: string; credential: string; oauthIssuer: string;
  oauthClientId: string; oauthClientSecret: string;
  oauthAuthMethod: "none" | "client_secret_post" | "client_secret_basic";
};
const emptyDraft = (): CustomConnectorDraft => ({ name: "", endpoint: "", credential: "", oauthIssuer: "", oauthClientId: "", oauthClientSecret: "", oauthAuthMethod: "none" });
function setupFailure(error: unknown, endpoint: string): string {
  if (error instanceof ConnectorSetupError) return error.message;
  if (error instanceof McpCatalogAuthenticationError) return "This server rejected the access token. Check it and try again.";
  try {
    if (/\/auth\/?$/i.test(new URL(endpoint.trim()).pathname)) return "That looks like a sign-in URL. Use the server’s MCP endpoint.";
  } catch { /* URL validation and server checks own the operation. */ }
  return "Couldn’t connect. Check the server URL and its access token.";
}
type CustomConnectorSettingsProps = { access: Access; enabled?: boolean;
  /** Synchronous authoritative unlock/expiry check; never a React snapshot. */
  isAccessCurrent?: () => boolean;
  onPrepareRecovery?: (input: { attemptId: string; reason: DriveChatRecoveryReason; customConnector?: CustomConnectorRecoveryReference }) => Promise<"ready" | "busy" | "unavailable">;
};

function savedConnector(record: CustomConnectorConfiguration): SavedConnector {
  return {
    connectorId: record.connectorId, displayName: record.displayName,
    revision: record.revision, enabled: record.enabled,
    authenticationKind: record.authentication.kind,
    hasOAuthRegistration: Boolean(record.oauthRegistration),
  };
}

/** Vault-backed definitions only. Saving is never provider authentication or tool approval. */
export function useCustomConnectorSettings({ access, enabled = true, isAccessCurrent, onPrepareRecovery }: CustomConnectorSettingsProps) {
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
  const editorVisit = useRef<object | null>(null);
  const [draft, setDraft] = useState(emptyDraft);
  const input = useRef({ value: draft, revision: 0 });
  const updateDraft = (value: CustomConnectorDraft) => {
    input.current = { value, revision: input.current.revision + 1 }; setDraft(value);
  };
  const { name, endpoint, credential, oauthIssuer, oauthClientId, oauthClientSecret, oauthAuthMethod } = draft;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const readSerial = useRef(0);
  const deferredRead = useRef(false);
  const [loadRevision, reload] = useState(0);
  const latestAccess = useRef(access), latestEnabled = useRef(enabled);
  const liveUnlockCheck = useRef(isAccessCurrent);
  const authGeneration = snapshotValidatedAuthSessionOwner()?.generation;
  const hasToken = Boolean(access.vaultOwnerToken);
  // Credential renewal is not a new unlock. This private comparison scope
  // holds no native projection or persistence authority; the authenticated
  // owner and actual key remain the existing source of permission.
  // Callers without live getters retain the old, conservative credential fence.
  const legacyCredential = isAccessCurrent ? null : access.vaultOwnerToken;
  const scope = useMemo(() => ({ active: false, userId: access.userId, key: access.vaultKey, hasToken, authGeneration, legacyCredential,
    owner: snapshotValidatedAuthSessionOwner(), epoch: snapshotVaultSessionEpoch() }),
    [access.userId, access.vaultKey, hasToken, authGeneration, legacyCredential]);
  useLayoutEffect(() => { latestAccess.current = access; latestEnabled.current = enabled; liveUnlockCheck.current = isAccessCurrent; });
  const currentOwner = useCallback(() => Boolean(scope.active && hasToken && access.vaultKey && scope.owner?.userId === access.userId &&
    latestAccess.current.userId === access.userId && latestAccess.current.vaultKey === access.vaultKey &&
    latestAccess.current.vaultOwnerToken && isValidatedAuthSessionOwnerCurrent(scope.owner) &&
    (liveUnlockCheck.current ? liveUnlockCheck.current() : isVaultSessionEpochCurrent(scope.epoch))),
  [scope, hasToken, access.userId, access.vaultKey]);

  useLayoutEffect(() => {
    scope.active = true; readSerial.current += 1; deferredRead.current = false;
    inFlight.current = false;
    setBusy(false); setError(null); setCatalogs({}); setAuthRequired({}); setCheckFailed({}); setRemoving(null);
    setItems([]); setInvalid([]); setRemovingInvalid(null); updateDraft(emptyDraft()); editorVisit.current = null; setEditing(false); setStatus("loading");
    return () => { scope.active = false; readSerial.current += 1; refreshAbort.current?.abort(); };
  }, [scope]);
  const epoch = snapshotVaultSessionEpoch();
  useEffect(() => {
    if (!enabled || !hasToken || !currentOwner()) return;
    if (inFlight.current) { deferredRead.current = true; return; }
    let active = true;
    const accessForLoad = { userId: access.userId, vaultKey: access.vaultKey, vaultOwnerToken: access.vaultOwnerToken }, attempt = ++readSerial.current;
    const current = () => active && latestEnabled.current && currentOwner() && attempt === readSerial.current &&
      latestAccess.current.vaultOwnerToken === accessForLoad.vaultOwnerToken && isVaultSessionEpochCurrent(epoch);
    setStatus("loading");
    void loadCustomConnectorSnapshot(accessForLoad, true).then(({ configurations: records, invalid: invalidRecords }) => {
      if (!current()) return;
      setItems(records.map(savedConnector));
      setInvalid(invalidRecords);
      const handoff = takeRefreshedMcpCatalog({ ownerUserId: accessForLoad.userId, vaultEpoch: epoch, configurations: records });
      if (handoff) setCatalogs({ [handoff.connectorId]: handoff.tools });
      setStatus("ready");
    }).catch(() => { if (current()) setStatus("failed"); });
    return () => { active = false; };
  }, [access.userId, access.vaultKey, access.vaultOwnerToken, currentOwner, enabled, epoch, hasToken, loadRevision]);

  const finish = (current: () => boolean) => {
    if (!current()) return;
    inFlight.current = false; setBusy(false);
    // Reconcile through the current credential after a confirmed/failed action;
    // never replay a write on renewal, close/reopen or an uncertain outcome.
    if (deferredRead.current || latestAccess.current.vaultOwnerToken !== access.vaultOwnerToken || status === "loading") {
      deferredRead.current = false; reload(value => value + 1);
    }
  };

  const save = async () => {
    if (inFlight.current || !currentOwner() || !enabled) return;
    inFlight.current = true; readSerial.current += 1; setBusy(true); setError(null);
    const current = currentOwner;
    const operation = (async () => {
      const configuration = newCustomConnectorConfiguration({
        displayName: name, endpoint,
        credential: credential.trim() ? { header: "Authorization", value: credential } : null,
        ...(oauthIssuer || oauthClientId || oauthClientSecret ? { oauthRegistration: {
          issuer: oauthIssuer.trim(), clientId: oauthClientId.trim(),
          ...(oauthAuthMethod !== "none" && oauthClientSecret ? { clientSecret: oauthClientSecret } : {}),
          tokenEndpointAuthMethod: oauthAuthMethod,
        } } : {}),
      });
      // A saved definition is not a connection: the shared path verifies first.
      const { configuration: saved, tools: discovered, signInNeeded } = await verifyAndSaveCustomConnector({
        access, configuration, isCurrent: current,
        signal: refreshAbort.current?.signal ?? new AbortController().signal,
        confirmation: { confirmedByUser: true, surface: Capacitor.getPlatform() === "ios" ? "ios" : Capacitor.getPlatform() === "android" ? "android" : "web", source: "connector_settings" },
      });
      if (!current()) return;
      setItems(previous => [...previous, savedConnector(saved)]);
      if (discovered) setCatalogs(previous => ({ ...previous, [saved.connectorId]: discovered }));
      if (signInNeeded) setAuthRequired(previous => ({ ...previous, [saved.connectorId]: true }));
      updateDraft(emptyDraft()); editorVisit.current = null; setEditing(false);
      return true;
    })();
    morphyToast.promise(operation, {
      loading: "Checking connector…", success: "Connector added.",
      error: (error) => setupFailure(error, endpoint),
    });
    try { return await operation === true; } catch (error) { if (current()) setError(setupFailure(error, endpoint)); return false; }
    finally { finish(current); }
  };

  const refresh = async (item: SavedConnector) => {
    if (inFlight.current || !currentOwner() || !enabled) return;
    inFlight.current = true; readSerial.current += 1; setBusy(true);
    const current = currentOwner;
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
    finally { finish(current); }
  };

  const connect = async (item: SavedConnector) => {
    if (inFlight.current || !currentOwner() || !enabled || !onPrepareRecovery) return;
    inFlight.current = true; readSerial.current += 1; setBusy(true);
    const current = currentOwner;
    const controller = new AbortController(); refreshAbort.current = controller;
    const operation = (async () => {
      const records = (await loadCustomConnectorSnapshot(access, true)).configurations;
      if (!current()) throw new Error("Session changed.");
      const configuration = records.find(record => record.connectorId === item.connectorId);
      if (!configuration || configuration.revision !== item.revision) throw new Error("Connector changed.");
      await beginCustomConnectorSignIn({ access, configuration, prepareRecovery: onPrepareRecovery,
        signal: controller.signal, isCurrent: current });
    })();
    morphyToast.promise(operation, { loading: "Preparing sign-in…", success: "Continue at your provider.", error: "Could not start sign-in. Check this server supports OAuth and try again." });
    try { await operation; } catch { /* The shared path cancels its attempt; the toast owns the failure. */ }
    finally { finish(current); }
  };

  const setToolBlocked = async (item: SavedConnector, tool: CatalogTool) => {
    if (inFlight.current || !currentOwner() || !enabled) return;
    inFlight.current = true; readSerial.current += 1; setBusy(true);
    const current = currentOwner;
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
    morphyToast.promise(operation, { loading: "Updating tool…", success: tool.permission === "blocked" ? "Tool available in new turns." : "Tool blocked for new turns.", error: "Could not update the tool. Refresh tools and try again." });
    try { await operation; } catch { /* The shared toast owns action errors. */ }
    finally { finish(current); }
  };

  const remove = async () => {
    if (!removing || inFlight.current || !currentOwner() || !enabled) return;
    const selected = removing;
    const current = currentOwner;
    inFlight.current = true; readSerial.current += 1; setBusy(true);
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
    finally { finish(current); }
  };

  const removeInvalid = async () => {
    if (!removingInvalid || inFlight.current || !currentOwner() || !enabled) return;
    const selected = removingInvalid;
    const current = currentOwner;
    inFlight.current = true; readSerial.current += 1; setBusy(true);
    const operation = removeInvalidCustomConnectorConfiguration(access, selected.connectorId,
      { confirmedByUser: true, surface: Capacitor.getPlatform() === "ios" ? "ios" : Capacitor.getPlatform() === "android" ? "android" : "web", source: "connector_settings" }, current);
    morphyToast.promise(operation, { loading: "Removing saved connector…", success: "Saved connector removed.", error: "Could not remove this connector. Reopen connectors and try again." });
    try {
      await operation;
      if (current()) { setInvalid(previous => previous.filter(item => item.connectorId !== selected.connectorId)); setRemovingInvalid(null); }
    } catch { /* Shared toast owns the failure. */ }
    finally { finish(current); }
  };

  // The adapter receives private facts and the same feature operations, never
  // access material. Replaced/unmounted presentation callbacks cannot revive a
  // setup editor or dispatch a saved callback against another credential owner.
  const binding = Symbol("custom-connector-presentation");
  const committed = useRef<symbol | null>(null);
  useLayoutEffect(() => { committed.current = binding; return () => { if (committed.current === binding) committed.current = null; }; });
  const current = currentOwner;
  const admitted = () => enabled && committed.current === binding && current();
  const run = (operation: () => Promise<unknown>) => async () => { if (admitted()) await operation(); };
  const editor = editing ? editorVisit.current : null;
  const editorCurrent = useCallback(() => editor !== null && editorVisit.current === editor && currentOwner(), [currentOwner, editor]);
  const closeEditor = () => {
    if (!inFlight.current) { updateDraft(emptyDraft()); setError(null); editorVisit.current = null; setEditing(false); }
  };
  return {
    items, invalid, catalogs, authRequired, checkFailed, status, editing, draft, busy, error, removing, removingInvalid,
    canSignIn: Boolean(onPrepareRecovery), current,
    mutationPending: () => inFlight.current,
    inputRevision: () => input.current.revision,
    changeDraft: (value: CustomConnectorDraft, expectedRevision = input.current.revision) => {
      if (!admitted() || inFlight.current || expectedRevision !== input.current.revision) return false;
      updateDraft(value); return true;
    },
    openEditor: () => { if (admitted() && !inFlight.current && status === "ready" && !editorVisit.current) { setError(null); editorVisit.current = {}; setEditing(true); } },
    cancelEditor: () => { if (admitted()) closeEditor(); },
    save: async () => admitted() && editing ? save() : false,
    refresh: (item: SavedConnector) => run(() => refresh(item))(),
    connect: (item: SavedConnector) => run(() => connect(item))(),
    setToolBlocked: (item: SavedConnector, tool: CatalogTool) => run(() => setToolBlocked(item, tool))(),
    requestRemove: (item: SavedConnector) => { if (admitted() && !inFlight.current && items.includes(item)) setRemoving(item); },
    requestRemoveInvalid: (item: InvalidCustomConnector) => { if (admitted() && !inFlight.current && invalid.includes(item)) setRemovingInvalid(item); },
    cancelRemove: () => { if (admitted() && !inFlight.current) { setRemoving(null); setRemovingInvalid(null); } },
    remove: run(remove), removeInvalid: run(removeInvalid),
    // Native confirmation may await UIKit while compatible list/status updates
    // commit. Bind this private editor to its visit and final input, not every
    // catalog render; an old visit still cannot cancel or save a reopened one.
    nativeEditor: {
      current: editorCurrent, draft, busy, error, inputRevision: () => input.current.revision,
      mutationPending: () => inFlight.current,
      changeDraft: (value: CustomConnectorDraft, expectedRevision = input.current.revision) => {
        if (!editorCurrent() || inFlight.current || expectedRevision !== input.current.revision) return false;
        updateDraft(value); return true;
      },
      save: async () => latestEnabled.current && editorCurrent() && input.current.value === draft ? save() : false,
      cancelEditor: () => { if (editorCurrent()) closeEditor(); },
    },
    // Existing web inputs use the same draft, including immediate final-input
    // revision updates. Native scenes validate their closed wire DTO separately.
    field: <K extends keyof CustomConnectorDraft>(key: K, value: CustomConnectorDraft[K]) => {
      if (admitted() && !inFlight.current) updateDraft({ ...input.current.value, [key]: value });
    },
  };
}
export type CustomConnectorSettingsModel = ReturnType<typeof useCustomConnectorSettings>;

export function CustomConnectorsSettings(props: CustomConnectorSettingsProps & {
  render?: (model: CustomConnectorSettingsModel, webBody: ReactNode) => ReactNode;
}) {
  const model = useCustomConnectorSettings(props);
  const { items, invalid, catalogs, authRequired, checkFailed, status, editing, busy, removing, removingInvalid,
    save, connect, refresh, setToolBlocked, remove, removeInvalid } = model;
  const { name, endpoint, credential, oauthIssuer, oauthClientId, oauthClientSecret, oauthAuthMethod } = model.draft;
  const webBody = <section aria-label="Custom connectors" className="space-y-3">
    <h3 className="text-sm font-medium text-muted-foreground">Custom connectors</h3>
    {status === "loading" ? <p role="status" className="text-sm">Loading saved connectors…</p> : null}
    {status === "failed" ? <p role="status" className="text-sm">Could not load saved connectors. Close and reopen to retry.</p> : null}
    {invalid.length > 0 ? <div role="status" className="rounded-xl bg-foreground/10 px-3 py-2 text-sm">
      <p>{invalid.length} saved {invalid.length === 1 ? "connector needs" : "connectors need"} repair. Other connectors remain available.</p>
      {invalid.map((item, index) => <div key={item.connectorId} className="flex min-h-11 items-center justify-between gap-3">
        <span>Saved connector {index + 1}</span>
        {item.removable ? <Button size="compact" variant="none" effect="fade" disabled={busy} onClick={() => model.requestRemoveInvalid(item)}>Remove</Button>
          : <span className="text-xs text-muted-foreground">Needs repair</span>}
      </div>)}
    </div> : null}
    <ul className="divide-y rounded-2xl bg-foreground/10">{items.map(item => <li key={item.connectorId} className="px-4 py-3">
      <p className="text-sm font-normal">{item.displayName}</p>
      <p className="text-xs text-muted-foreground">{!item.enabled ? "Blocked for new turns"
        : authRequired[item.connectorId] ? item.authenticationKind === "api_key"
          ? "Saved credential rejected · remove and add again"
          : "Sign in needed"
        : checkFailed[item.connectorId] ? "Connection check failed · verify server address and credential"
        : catalogs[item.connectorId] ? `${catalogs[item.connectorId]?.length ?? 0} tools discovered`
        : item.authenticationKind === "none" ? "Sign in or refresh tools to verify" : "Tools not checked"}</p>
      <div className="flex flex-wrap gap-2">
        {model.canSignIn && item.authenticationKind !== "api_key" && (item.hasOAuthRegistration || item.authenticationKind === "oauth" || authRequired[item.connectorId])
          ? <Button size="compact" variant="none" effect="fade" aria-label={`Sign in to ${item.displayName}`} disabled={busy || !item.enabled} onClick={() => void connect(item)}>Sign in</Button> : null}
        <Button size="compact" variant="none" effect="fade" aria-label={`Refresh tools for ${item.displayName}`} disabled={busy || !item.enabled} onClick={() => void refresh(item)}>Refresh tools</Button>
        <Button size="compact" variant="none" effect="fade" aria-label={`Remove ${item.displayName}`} disabled={busy} onClick={() => model.requestRemove(item)}>Remove</Button>
      </div>
      {catalogs[item.connectorId] ? <details className="text-sm"><summary className="min-h-11 cursor-pointer py-3">{catalogs[item.connectorId]?.length} tools</summary>
        <ul className="max-h-60 overflow-y-auto">{catalogs[item.connectorId]?.map(tool => <li key={tool.id} className="flex min-h-11 items-center justify-between gap-3 border-t py-1">
          <span className="min-w-0 break-words">{tool.name}</span>
          <Button size="compact" variant="none" effect="fade" disabled={busy || !item.enabled}
            aria-label={`${tool.permission === "blocked" ? "Allow" : "Block"} ${tool.name} in ${item.displayName}`}
            onClick={() => void setToolBlocked(item, tool)}>{tool.permission === "blocked" ? "Blocked · Allow"
              : tool.review === "not_required" ? "Runs without asking · Block" : "Ask first · Block"}</Button>
        </li>)}</ul>
      </details> : null}
    </li>)}</ul>
    {editing ? <form className="space-y-3" onSubmit={event => { event.preventDefault(); void save(); }}>
      <label className="block space-y-1 text-sm">Name<Input required maxLength={100} value={name} disabled={busy} onChange={event => model.field("name", event.target.value)} /></label>
      <label className="block space-y-1 text-sm">Server URL<Input required type="url" placeholder="https://example.com/mcp" value={endpoint} disabled={busy} onChange={event => model.field("endpoint", event.target.value)} /></label>
      <label className="block space-y-1 text-sm">Access token (optional)<Input type="password" autoComplete="off" maxLength={8192} value={credential} disabled={busy} onChange={event => model.field("credential", event.target.value)} /></label>
      <p className="text-xs text-muted-foreground">Sent as “Authorization: Bearer” and kept in your vault. Use the server endpoint, not its sign-in page. Never use your vault token.</p>
      <details className="text-sm"><summary className="min-h-11 cursor-pointer py-3">OAuth settings</summary>
        <div className="space-y-3 pb-3">
          <label className="block space-y-1">Authorization server issuer<Input type="url" placeholder="https://accounts.example.com" maxLength={2048} value={oauthIssuer} disabled={busy} onChange={event => model.field("oauthIssuer", event.target.value)} /></label>
          <label className="block space-y-1">Client ID<Input maxLength={8192} autoComplete="off" value={oauthClientId} disabled={busy} onChange={event => model.field("oauthClientId", event.target.value)} /></label>
          <label className="block space-y-1">Token authentication<select className="flex min-h-11 w-full rounded-[var(--app-input-radius)] border border-input bg-background px-3" value={oauthAuthMethod} disabled={busy} onChange={event => { const method = event.target.value as typeof oauthAuthMethod; model.field("oauthAuthMethod", method); if (method === "none") model.field("oauthClientSecret", ""); }}><option value="none">Public client</option><option value="client_secret_post">Client secret in request</option><option value="client_secret_basic">Client secret in header</option></select></label>
          {oauthAuthMethod !== "none" ? <label className="block space-y-1">Client secret<Input type="password" autoComplete="off" maxLength={8192} value={oauthClientSecret} disabled={busy} onChange={event => model.field("oauthClientSecret", event.target.value)} /></label> : null}
        </div>
      </details>
      <p className="text-xs text-muted-foreground">Only add servers you trust. One uses this server’s tools without asking each time. Block any tool you don’t want it to use.</p>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="compact" effect="fade" disabled={busy}>Add</Button>
        <Button type="button" size="compact" variant="none" effect="fade" disabled={busy} onClick={model.cancelEditor}>Cancel</Button>
      </div>
    </form> : <Button size="compact" variant="none" effect="fade" disabled={status !== "ready"} onClick={model.openEditor}>Add connector</Button>}
    <AlertDialog open={Boolean(removing)} onOpenChange={open => { if (!open && !busy) model.cancelRemove(); }}>
      <AlertDialogContent>
        <AlertDialogHeader><AlertDialogTitle>Remove {removing?.displayName}?</AlertDialogTitle>
          <AlertDialogDescription>This removes its saved settings from your vault. It does not revoke access at the provider or undo completed actions.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter><AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction disabled={busy} onClick={event => { event.preventDefault(); void remove(); }}>Remove connector</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    <AlertDialog open={Boolean(removingInvalid)} onOpenChange={open => { if (!open && !busy) model.cancelRemove(); }}>
      <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Remove invalid connector?</AlertDialogTitle>
        <AlertDialogDescription>Its saved settings cannot be used. This removes only that connector from your vault; it does not revoke access at the provider.</AlertDialogDescription>
      </AlertDialogHeader><AlertDialogFooter><AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
        <AlertDialogAction disabled={busy} onClick={event => { event.preventDefault(); void removeInvalid(); }}>Remove connector</AlertDialogAction>
      </AlertDialogFooter></AlertDialogContent>
    </AlertDialog>
  </section>;
  return props.render ? props.render(model, webBody) : webBody;
}
