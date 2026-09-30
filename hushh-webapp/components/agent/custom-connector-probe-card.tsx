"use client";

import { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useVault } from "@/lib/vault/vault-context";
import { Button } from "@/lib/morphy-ux/button";
import { MaterialRipple } from "@/lib/morphy-ux/material-ripple";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ConnectedSystemsAgentIcon, EyeIcon, KeyIcon, PencilIcon } from "@/components/icons";
import { McpCatalogAuthenticationError } from "@/lib/services/external-connector-service";
import { loadCustomConnectorSnapshot } from "@/lib/connections/custom-connector-configuration";
import {
  beginCustomConnectorSignIn,
  ConnectorSetupError,
  newCustomConnectorConfiguration,
  verifyAndSaveCustomConnector,
  type ConnectorCredential,
  type PrepareRecovery,
} from "@/lib/connections/custom-connector-setup";
import {
  PROBE_FAILURE_COPY,
  type CustomConnectorProbeExperience,
} from "@/lib/agent/custom-connector-probe";
import type { WorkspaceConnectorProvider } from "@/lib/agent/connector-read-receipt";

/** Chat supplies the same OAuth return hook the Connectors sheet uses. */
export const CustomConnectorChatContext = createContext<{ prepareRecovery?: PrepareRecovery }>({});

type Outcome =
  | { kind: "idle" }
  | { kind: "working"; label: string }
  | { kind: "connected"; tools: number; blocked: number }
  | { kind: "already"; name: string }
  | { kind: "signing_in" }
  | { kind: "error"; title: string; next: string };

const TOOLS_PREVIEW = 4;
// Every glyph sits in the same 32 pt well, so all glyph centres share one axis
// and text always starts 44 pt in (32 well + 12 gap).
const GLYPH_WELL = "flex size-8 shrink-0 items-center justify-center";
const GLYPH = "size-5";
const FIRST_LINE = "min-w-0 flex-1 py-1.5 leading-5";

function needCopy(experience: CustomConnectorProbeExperience): string {
  const auth = experience.auth;
  if (auth.kind === "none") return "Connecting needs nothing else.";
  if (auth.kind === "api_key") return "Connecting needs an access key from this server.";
  if (auth.signIn === "ready") return `Connecting needs you to sign in${auth.issuerHost ? ` with ${auth.issuerHost}` : ""}.`;
  if (auth.signIn === "client_id_needed") return "Sign-in needs a client ID from the provider. Add it in Connectors.";
  return "One can’t use this server’s sign-in yet. An access key may work instead.";
}

function ToolGroup({ label, icon, tools }: {
  label: string; icon: ReactNode; tools: CustomConnectorProbeExperience["tools"];
}) {
  const [expanded, setExpanded] = useState(false);
  if (!tools.length) return null;
  const shown = expanded ? tools : tools.slice(0, TOOLS_PREVIEW);
  return (
    <div className="mt-4" data-probe-group={label}>
      <p className="flex h-8 items-center gap-3 text-xs font-medium text-muted-foreground" data-probe-line>
        <span aria-hidden className={GLYPH_WELL} data-probe-glyph>{icon}</span>
        <span>{label} · {tools.length}</span>
      </p>
      {/* Dividers start at the text column, not under the glyph column. */}
      <ul className="ml-11 divide-y divide-border/60" aria-label={label}>
        {shown.map(tool => (
          // One fixed row height on the 4 pt grid: a one-line name and at most
          // two description lines, so rows never drift with server text length.
          <li key={tool.name} data-probe-tool-row className="flex h-17 flex-col justify-center" title={tool.description || undefined}>
            {/* Plain text only: server strings never become markup, links or actions. */}
            <span className="truncate font-mono text-[13px] leading-5 text-foreground">{tool.name}</span>
            {tool.description ? <span className="line-clamp-2 text-xs leading-4 text-muted-foreground">{tool.description}</span> : null}
          </li>
        ))}
      </ul>
      {tools.length > TOOLS_PREVIEW ? (
        <button type="button" className="relative ml-11 flex h-11 items-center overflow-hidden text-xs font-medium text-primary"
          onClick={() => setExpanded(value => !value)}>
          {expanded ? "Show fewer" : `Show all ${tools.length}`}
          {/* Flat Morphy ripple; no glass material (reverted 2026-09-20). */}
          <MaterialRipple variant="none" effect="fill" />
        </button>
      ) : null}
    </div>
  );
}

export function CustomConnectorProbeCard({ experience, onOpenConnections }: {
  experience: CustomConnectorProbeExperience;
  onOpenConnections?: (provider: WorkspaceConnectorProvider, trigger: HTMLButtonElement) => void;
}) {
  const { user } = useAuth();
  const { vaultKey, vaultOwnerToken } = useVault();
  const { prepareRecovery } = useContext(CustomConnectorChatContext);
  const [outcome, setOutcome] = useState<Outcome>({ kind: "idle" });
  const [sheetOpen, setSheetOpen] = useState(false);
  const [secret, setSecret] = useState("");
  const [header, setHeader] = useState<ConnectorCredential["header"]>("Authorization");
  const busy = useRef(false);
  const alive = useRef(true);
  const secretId = useId();
  const headerId = useId();
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const reads = experience.tools.filter(tool => tool.access === "read");
  const writes = experience.tools.filter(tool => tool.access === "write");
  const name = experience.serverName ?? experience.host;
  const access = user?.uid && vaultKey && vaultOwnerToken
    ? { userId: user.uid, vaultKey, vaultOwnerToken } : null;
  const settled = outcome.kind === "connected" || outcome.kind === "already" || outcome.kind === "signing_in";
  const canConnect = Boolean(access) && !settled && outcome.kind !== "working";

  const connect = async (options: { credential?: ConnectorCredential; blockWrites?: boolean; signIn?: boolean }) => {
    if (busy.current || !access) return;
    busy.current = true;
    const owner = access.userId;
    const current = () => alive.current && user?.uid === owner;
    const controller = new AbortController();
    setOutcome({ kind: "working", label: options.signIn ? "Preparing sign-in…" : "Connecting…" });
    try {
      const existing = (await loadCustomConnectorSnapshot(access, true)).configurations
        .find(record => record.endpoint === experience.endpoint);
      if (existing && !options.signIn) { setOutcome({ kind: "already", name: existing.displayName }); return; }
      const configuration = existing ?? newCustomConnectorConfiguration({
        displayName: name, endpoint: experience.endpoint, credential: options.credential ?? null,
      });
      const added = existing
        ? { configuration: existing, tools: null, signInNeeded: true }
        : await verifyAndSaveCustomConnector({
          access, configuration, signal: controller.signal, isCurrent: current,
          blockWrites: options.blockWrites,
          confirmation: { confirmedByUser: true, surface: "chat", source: "chat_connector_card" },
        });
      if (!current()) return;
      if (!added.signInNeeded && added.tools) {
        setOutcome({ kind: "connected", tools: added.tools.length,
          blocked: added.tools.filter(tool => tool.permission === "blocked").length });
        return;
      }
      if (!prepareRecovery) {
        setOutcome({ kind: "error", title: `${name} is saved and needs sign-in`, next: "Open Connectors and choose Sign in." });
        return;
      }
      setOutcome({ kind: "signing_in" });
      await beginCustomConnectorSignIn({ access, configuration: added.configuration, prepareRecovery,
        signal: controller.signal, isCurrent: current });
    } catch (error) {
      if (!current()) return;
      setOutcome(error instanceof McpCatalogAuthenticationError
        ? { kind: "error", title: "The server rejected that key", next: "Check the key and its permissions, then try again." }
        : error instanceof ConnectorSetupError
          ? { kind: "error", title: error.message, next: "Nothing was saved." }
          : { kind: "error", title: `Couldn’t connect ${name}`, next: "Nothing was saved. Ask One to check the server again." });
    } finally {
      busy.current = false;
    }
  };

  const submitSecret = () => {
    const value = secret;
    // The key lives only in this sheet, then in the encrypted vault record.
    // It never enters the transcript, the model request or this card's props.
    setSecret("");
    setSheetOpen(false);
    if (value.trim()) void connect({ credential: { header, value } });
  };

  if (experience.status === "failed" && experience.failure) {
    const copy = PROBE_FAILURE_COPY[experience.failure];
    return (
      <section aria-label="MCP server check" data-testid="custom-connector-probe"
        className="w-full min-w-0 rounded-[16px] bg-foreground/[0.035] p-4 text-sm dark:bg-white/[0.045]">
        <div className="flex items-start gap-3" data-probe-line>
          <span aria-hidden className={GLYPH_WELL} data-probe-glyph>
            <ConnectedSystemsAgentIcon className={GLYPH} />
          </span>
          <div className="min-w-0 flex-1">
            <p role="status" className={`${FIRST_LINE} font-medium text-foreground`}>{copy.title}</p>
            <p className="text-muted-foreground">{copy.next}</p>
          </div>
        </div>
      </section>
    );
  }

  const primary = experience.auth.kind === "none"
    ? { label: `Connect ${name}`, run: () => void connect({}) }
    : experience.auth.kind === "api_key" || experience.auth.signIn === "unsupported"
      ? { label: "Add access key", run: () => setSheetOpen(true) }
      : experience.auth.signIn === "ready"
        ? { label: "Sign in to connect", run: () => void connect({ signIn: true }) }
        : null;

  return (
    <section aria-label={`MCP server ${name}`} data-testid="custom-connector-probe"
      className="w-full min-w-0 rounded-[16px] bg-foreground/[0.035] p-4 text-sm dark:bg-white/[0.045]">
      <div className="flex items-start gap-3" data-probe-header data-probe-line>
        <span aria-hidden className={GLYPH_WELL} data-probe-glyph>
          <ConnectedSystemsAgentIcon className={GLYPH} />
        </span>
        <div className="min-w-0 flex-1">
          <p className={`${FIRST_LINE} break-words font-medium text-foreground`}>{name}</p>
          {name !== experience.host ? <p className="break-all text-xs leading-4 text-muted-foreground">{experience.host}</p> : null}
        </div>
      </div>
      {experience.requestedEndpoint ? (
        <p className="mt-4 pl-11 text-xs leading-4 text-muted-foreground">
          The address you gave no longer answers. The same server answers at {new URL(experience.endpoint).pathname}, so One will use that.
        </p>
      ) : null}
      {experience.tools.length ? (
        <div>
          <ToolGroup label="Only reads" icon={<EyeIcon className={GLYPH} />} tools={reads} />
          <ToolGroup label="May change things" icon={<PencilIcon className={GLYPH} />} tools={writes} />
          {experience.toolCount > experience.tools.length ? (
            <p className="mt-2 pl-11 text-xs text-muted-foreground">
              Showing {experience.tools.length} of {experience.toolCount} tools.
            </p>
          ) : null}
        </div>
      ) : experience.status === "ready" ? (
        <p className="mt-4 pl-11 text-xs leading-4 text-muted-foreground">This server doesn’t offer any tools.</p>
      ) : (
        <p className="mt-4 pl-11 text-xs leading-4 text-muted-foreground">It shows its tools after you connect.</p>
      )}
      <p className="mt-4 flex items-start gap-3 text-foreground" data-probe-line>
        <span aria-hidden className={GLYPH_WELL} data-probe-glyph><KeyIcon className={GLYPH} /></span>
        {/* 6 + half a 20 pt line = 16: the glyph centres on the FIRST line when copy wraps. */}
        <span className={FIRST_LINE}>{needCopy(experience)}</span>
      </p>
      <p className="mt-1 pl-11 text-xs leading-4 text-muted-foreground">
        Only connect servers you trust. One uses their tools without asking each time; you can block any tool in Connectors.
      </p>
      <div role="status" aria-live="polite" className="mt-4 pl-11 empty:hidden" data-probe-outcome>
        {outcome.kind === "working" ? <p className="text-muted-foreground">{outcome.label}</p>
          : outcome.kind === "connected" ? <p className="font-medium text-foreground">
            Connected. {outcome.tools} {outcome.tools === 1 ? "tool" : "tools"} ready
            {outcome.blocked ? `, ${outcome.blocked} that may change things blocked` : ""}.
          </p>
            : outcome.kind === "already" ? <p className="text-foreground">Already saved as {outcome.name}.</p>
              : outcome.kind === "signing_in" ? <p className="text-muted-foreground">Continue at the sign-in page. You’ll come back to this chat.</p>
                : outcome.kind === "error" ? <><p className="font-medium text-foreground">{outcome.title}</p><p className="text-muted-foreground">{outcome.next}</p></>
                  : null}
      </div>
      {!access ? <p className="mt-4 pl-11 text-muted-foreground">Unlock your vault to connect.</p> : null}
      {!settled ? (
        <div className="mt-4 grid grid-cols-1 gap-2 sm:flex sm:flex-wrap" data-probe-actions>
          {primary ? (
            <Button type="button" size="compact" disabled={!canConnect} onClick={primary.run}>{primary.label}</Button>
          ) : onOpenConnections ? (
            <Button type="button" size="compact" variant="muted" onClick={event => onOpenConnections("custom", event.currentTarget)}>Open Connectors</Button>
          ) : null}
          {experience.auth.kind === "none" && writes.length ? (
            <Button type="button" size="compact" variant="muted" disabled={!canConnect}
              onClick={() => void connect({ blockWrites: true })}>Connect read-only</Button>
          ) : null}
        </div>
      ) : null}
      <Dialog open={sheetOpen} onOpenChange={open => { setSheetOpen(open); if (!open) setSecret(""); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Access key for {name}</DialogTitle>
            <DialogDescription>
              Saved only in your encrypted vault. It never appears in this chat and is never sent to One’s model.
            </DialogDescription>
          </DialogHeader>
          <form className="space-y-4" onSubmit={event => { event.preventDefault(); submitSecret(); }}>
            <label htmlFor={secretId} className="block space-y-2 text-sm">
              <span>Key or token</span>
              <Input id={secretId} type="password" autoComplete="off" spellCheck={false} maxLength={8192}
                value={secret} onChange={event => setSecret(event.target.value)} />
            </label>
            <label htmlFor={headerId} className="block space-y-2 text-sm">
              <span>Send it as</span>
              <select id={headerId} value={header} onChange={event => setHeader(event.target.value as ConnectorCredential["header"])}
                className="flex min-h-11 w-full rounded-[var(--app-input-radius)] border border-input bg-background px-3">
                <option value="Authorization">Authorization: Bearer</option>
                <option value="X-API-Key">X-API-Key header</option>
              </select>
            </label>
            <DialogFooter>
              <Button type="submit" size="compact" disabled={!secret.trim()}>Connect</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  );
}
