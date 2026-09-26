"use client";

import { useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { Button } from "@/lib/morphy-ux/button";
import { morphyToast } from "@/lib/morphy-ux/morphy";
import { useAuth } from "@/hooks/use-auth";
import { useGmailConnectorStatus } from "@/lib/profile/gmail-connector-store";
import { useCalendarConnectionStatus } from "@/lib/calendar/use-calendar-connection-status";
import { ExternalConnectorService } from "@/lib/services/external-connector-service";
import { VaultContext } from "@/lib/vault/vault-context";
import { ConnectorBrandMark, connectorBrandFor, type ConnectorBrand } from "@/components/agent/connector-brand-mark";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import type {
  ConnectorReadExperience,
  WorkspaceConnectorProvider,
  WorkspaceConnectorSetupExperience,
} from "@/lib/agent/connector-read-receipt";

const STATUS_TEXT: Record<ConnectorReadExperience["status"], string> = {
  ok: "Mail metadata checked",
  input_required: "Mail needs more detail",
  connect_required: "Connect Mail to continue",
  reconnect_required: "Reconnect Mail to continue",
  connection_changed: "Mail connection changed. Try again.",
  permission_denied: "Mail did not allow this read",
  source_changed: "Your inbox changed. Try again.",
  response_too_large: "Try a narrower inbox search",
  invalid_argument: "Ask for an inbox search or messages needing a reply",
  unavailable: "Mail is temporarily unavailable",
};
const DRIVE_STATUS: Record<ConnectorReadExperience["status"], string> = {
  ok: "Drive files checked",
  input_required: "Drive needs more detail",
  connect_required: "Connect Drive to continue",
  reconnect_required: "Reconnect Drive to continue",
  connection_changed: "Drive connection changed. Try again.",
  permission_denied: "Google did not allow this read",
  source_changed: "A file or its access changed. Try again.",
  response_too_large: "Try a narrower Drive search",
  invalid_argument: "Ask a brief question about your Drive files",
  unavailable: "Drive is temporarily unavailable",
};

export function ConnectorReadReceipt({ experience, onOpenConnections }: {
  experience: ConnectorReadExperience;
  onOpenConnections?: (provider: WorkspaceConnectorProvider, trigger: HTMLButtonElement) => void;
}) {
  const needsConnection = ["connect_required", "reconnect_required", "permission_denied"].includes(experience.status);
  const drive = experience.connector === "drive";
  return (
    <section aria-label={drive ? "Drive read details" : "Mail read details"} className="min-w-0 space-y-2 text-sm text-muted-foreground">
      <p role="status">{(drive ? DRIVE_STATUS : STATUS_TEXT)[experience.status]}</p>
      {experience.status === "ok" ? (
        <>
          <p>{drive ? (experience.metadataOnly ? "Drive file matches" : "Drive excerpts") : "Metadata only"} · {experience.sourceRefs.length} cited {experience.sourceRefs.length === 1 ? "source" : "sources"}</p>
          {experience.sourceRefs.length > 0 ? (
            <ul aria-label={drive ? "Document sources" : "Mail sources"} className="flex flex-wrap gap-x-3 gap-y-1">
              {experience.sourceRefs.map((ref, index) => <li key={ref}>{drive ? `${experience.metadataOnly ? "File" : "Document excerpt"} ${index + 1}${experience.sourcePages?.[index] ? ` · page ${experience.sourcePages[index]}` : ""}` : `Mail ${ref.slice(5)}`}</li>)}
            </ul>
          ) : null}
          {experience.truncated ? <p>{drive && !experience.metadataOnly ? "Some document content was omitted." : "Some matches or metadata were omitted."}</p> : null}
        </>
      ) : null}
      {needsConnection && onOpenConnections ? (
        <Button type="button" variant="muted" size="compact" onClick={(event) => onOpenConnections(drive ? "drive" : "gmail", event.currentTarget)}>
          {experience.status === "connect_required"
            ? `Connect ${drive ? "Drive" : "Gmail"}`
            : `Review ${drive ? "Drive" : "Gmail"} access`}
        </Button>
      ) : null}
    </section>
  );
}

const WORKSPACE_PROVIDER_LABEL: Record<WorkspaceConnectorProvider, string> = {
  drive: "Drive",
  gmail: "Gmail",
  calendar: "Calendar",
  custom: "Connectors",
};

/**
 * One surface for every connector card in a turn: the Activity panel's inset
 * tone and radius, full message-column width, the official mark aligned with
 * the title, and a single trailing action so the card reads balanced.
 */
function ConnectorCardShell({
  ariaLabel,
  brand,
  title,
  detail,
  action,
  children,
  testId = "workspace-connector-setup",
}: {
  ariaLabel: string;
  brand: ConnectorBrand | null;
  title: ReactNode;
  detail?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
  testId?: string;
}) {
  return (
    <section
      aria-label={ariaLabel}
      className="w-full min-w-0 rounded-[16px] bg-foreground/[0.035] p-3 text-sm dark:bg-white/[0.045]"
      data-testid={testId}
    >
      <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          {brand ? <ConnectorBrandMark brand={brand} /> : null}
          <div className="min-w-0 flex-1">
            <p role="status" className="flex min-h-8 items-center font-medium text-foreground">{title}</p>
            {detail ? <p className="text-muted-foreground">{detail}</p> : null}
          </div>
        </div>
        {action ? <div className="flex shrink-0 sm:justify-end">{action}</div> : null}
      </div>
      {children}
    </section>
  );
}

type LiveConnectionState = "checking" | "connected" | "reconnect" | "not_connected" | "unknown";

/**
 * A restored card must show the connection as it is now, not the prompt the
 * turn saw. Status reads use the same owner-scoped services as the connector
 * surface; a failed read keeps the original prompt ("unknown").
 */
function useLiveConnection(provider: WorkspaceConnectorProvider): LiveConnectionState {
  const { user } = useAuth();
  const vaultOwnerToken = useContext(VaultContext)?.vaultOwnerToken ?? null;
  const idTokenProvider = useCallback(() => user?.getIdToken() ?? Promise.resolve(""), [user]);
  const calendar = useCalendarConnectionStatus({
    userId: provider === "calendar" ? user?.uid ?? null : null,
    idTokenProvider: provider === "calendar" && user ? idTokenProvider : null,
  });
  const [drive, setDrive] = useState<{ token: string; state: LiveConnectionState } | null>(null);
  useEffect(() => {
    if (provider !== "drive" || !vaultOwnerToken) return;
    let cancelled = false;
    void ExternalConnectorService.overview(vaultOwnerToken).then((overview) => {
      const status = overview.connectors.find((item) => item.connectorId === "google_drive")?.status;
      if (!cancelled) setDrive({
        token: vaultOwnerToken,
        state: status === "connected" ? "connected" : status === "needs_reauth" ? "reconnect" : status ? "not_connected" : "unknown",
      });
    }).catch(() => { if (!cancelled) setDrive({ token: vaultOwnerToken, state: "unknown" }); });
    return () => { cancelled = true; };
  }, [provider, vaultOwnerToken]);
  if (provider === "calendar") {
    if (!calendar.loaded) return user ? "checking" : "unknown";
    if (calendar.error || !calendar.status) return "unknown";
    if (calendar.connected) return "connected";
    return calendar.status.status === "needs_reauth" ? "reconnect" : "not_connected";
  }
  if (provider === "drive") {
    if (!vaultOwnerToken) return "unknown";
    return drive?.token === vaultOwnerToken ? drive.state : "checking";
  }
  return "unknown";
}

export function WorkspaceConnectorSetupCard({
  experience,
  onOpenConnections,
}: {
  experience: WorkspaceConnectorSetupExperience;
  onOpenConnections?: (provider: WorkspaceConnectorProvider, trigger: HTMLButtonElement) => void;
}) {
  if (experience.provider === "gmail") return <GmailConnectorChatCard onOpenConnections={onOpenConnections} />;
  if (experience.provider === "custom") return <CustomConnectorsCard experience={experience} onOpenConnections={onOpenConnections} />;
  return <GoogleConnectorSetupCard experience={experience} onOpenConnections={onOpenConnections} />;
}

function GoogleConnectorSetupCard({
  experience,
  onOpenConnections,
}: {
  experience: WorkspaceConnectorSetupExperience;
  onOpenConnections?: (provider: WorkspaceConnectorProvider, trigger: HTMLButtonElement) => void;
}) {
  const label = WORKSPACE_PROVIDER_LABEL[experience.provider];
  const live = useLiveConnection(experience.provider);
  const connected = live === "connected" || (live !== "not_connected" && live !== "reconnect" && experience.status === "manage_available");
  const reconnect = live === "reconnect";
  const title = connected
    ? `${label} · Connected`
    : reconnect
      ? `Reconnect ${label} to continue`
      : `Connect ${label} to continue`;
  const actionLabel = connected ? `Manage ${label}` : reconnect ? `Reconnect ${label}` : `Connect ${label}`;
  return (
    <ConnectorCardShell
      ariaLabel={`${label} connection`}
      brand={connectorBrandFor(experience.provider)}
      title={title}
      detail={connected ? undefined : "One will use only the access you approve. Connecting does not share information with anyone."}
      action={onOpenConnections ? (
        <Button
          type="button"
          variant="muted"
          size="compact"
          disabled={live === "checking"}
          onClick={(event) => onOpenConnections(experience.provider, event.currentTarget)}
        >
          {actionLabel}
        </Button>
      ) : null}
    />
  );
}

function CustomConnectorsCard({
  experience,
  onOpenConnections,
}: {
  experience: WorkspaceConnectorSetupExperience;
  onOpenConnections?: (provider: WorkspaceConnectorProvider, trigger: HTMLButtonElement) => void;
}) {
  return (
    <ConnectorCardShell
      ariaLabel="Connectors"
      brand={null}
      title="Your connectors"
      detail={experience.saved?.length ? undefined : "No custom connectors saved."}
      action={onOpenConnections ? (
        <Button type="button" variant="muted" size="compact" onClick={(event) => onOpenConnections("custom", event.currentTarget)}>
          Open connectors
        </Button>
      ) : null}
    >
      {experience.saved?.length ? <ul className="mt-2 divide-y divide-border" aria-label="Saved connectors">
        {experience.saved.map(item => <li key={item.id} className="flex min-h-11 items-center justify-between gap-3 py-1">
          <span className="min-w-0 truncate text-foreground">{item.name}</span>
          <span className="shrink-0 text-xs text-muted-foreground">{item.status === "reconnect_needed" ? "Reconnect needed" : item.status === "disabled" ? "Off" : "Tools not checked"}</span>
        </li>)}
      </ul> : null}
    </ConnectorCardShell>
  );
}

function GmailConnectorChatCard({ onOpenConnections }: {
  onOpenConnections?: (provider: WorkspaceConnectorProvider, trigger: HTMLButtonElement) => void;
}) {
  const { user } = useAuth();
  const token = useCallback(() => user?.getIdToken() ?? Promise.resolve(""), [user]);
  const gmail = useGmailConnectorStatus({ userId: user?.uid, idTokenProvider: user ? token : null });
  const [confirm, setConfirm] = useState(false);
  const [confirmOwner, setConfirmOwner] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ownerUid = user?.uid;
  const refreshGmailStatus = gmail.refreshStatus;
  useEffect(() => {
    if (!ownerUid) return;
    void refreshGmailStatus().catch(() => undefined);
  }, [ownerUid, refreshGmailStatus]);
  useEffect(() => {
    if (confirmOwner && confirmOwner !== user?.uid) setConfirm(false);
  }, [confirmOwner, user?.uid]);
  const connected = Boolean(gmail.status?.connected && !gmail.status?.needs_reauth);
  const action = connected ? "Disconnect Gmail" : gmail.status?.needs_reauth ? "Reconnect Gmail" : "Connect Gmail";
  const gmailState = gmail.loadingStatus && !gmail.status ? "Checking" : connected ? "Connected" : gmail.status?.needs_reauth ? "Reconnect needed" : "Not connected";
  return <ConnectorCardShell
    ariaLabel="Gmail connection"
    brand="gmail"
    title={`Gmail · ${gmailState}`}
    detail={!connected ? "Connecting does not share information with anyone." : undefined}
    action={<Button type="button" variant="muted" size="compact" disabled={busy || !user || (!connected && !onOpenConnections) || (gmail.loadingStatus && !gmail.status)}
      onClick={event => { if (connected) { setConfirmOwner(user?.uid ?? null); setConfirm(true); } else onOpenConnections?.("gmail", event.currentTarget); }}>{action}</Button>}
  >
    <AlertDialog open={confirm} onOpenChange={setConfirm}><AlertDialogContent size="sm"><AlertDialogHeader>
      <AlertDialogTitle>Disconnect Gmail?</AlertDialogTitle>
      <AlertDialogDescription>One will no longer read your Gmail through this connection. This does not revoke access in your Google Account.</AlertDialogDescription>
    </AlertDialogHeader><AlertDialogFooter><AlertDialogCancel size="standard" className="min-w-0 w-full px-3" disabled={busy}>Cancel</AlertDialogCancel>
      <AlertDialogAction size="standard" className="min-w-0 w-full px-3" aria-label="Disconnect Gmail" disabled={busy} onClick={event => {
        event.preventDefault();
        if (!confirmOwner || confirmOwner !== user?.uid || !connected) { setConfirm(false); return; }
        setBusy(true);
        const operation = gmail.disconnectGmail().then(result => {
          if (!result || result.connected) throw new Error("disconnect_failed");
          setConfirm(false);
        });
        morphyToast.promise(operation, { loading: "Disconnecting Gmail…", success: "Gmail disconnected.", error: "Could not disconnect Gmail. Check and retry." });
        void operation.catch(() => undefined).finally(() => setBusy(false));
      }}>Disconnect</AlertDialogAction>
    </AlertDialogFooter></AlertDialogContent></AlertDialog>
  </ConnectorCardShell>;
}
