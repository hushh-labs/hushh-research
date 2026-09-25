"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/lib/morphy-ux/button";
import { useAuth } from "@/hooks/use-auth";
import { useGmailConnectorStatus } from "@/lib/profile/gmail-connector-store";
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

export function WorkspaceConnectorSetupCard({
  experience,
  onOpenConnections,
}: {
  experience: WorkspaceConnectorSetupExperience;
  onOpenConnections?: (provider: WorkspaceConnectorProvider, trigger: HTMLButtonElement) => void;
}) {
  const label = WORKSPACE_PROVIDER_LABEL[experience.provider];
  const manage = experience.status === "manage_available";
  if (experience.provider === "gmail") return <GmailConnectorChatCard onOpenConnections={onOpenConnections} />;
  return (
    <section
      aria-label={manage && experience.provider === "custom" ? "Connectors" : `${label} connection`}
      className="min-w-0 max-w-xl space-y-3 rounded-2xl border border-border bg-card p-3 text-sm text-muted-foreground sm:p-4"
      data-testid="workspace-connector-setup"
    >
      <p role="status" className="font-medium text-foreground">{manage ? experience.provider === "custom" ? "Your connectors" : `${label} is available` : `Connect ${label} to continue`}</p>
      {manage && experience.saved?.length ? <ul className="divide-y divide-border" aria-label="Saved connectors">
        {experience.saved.map(item => <li key={item.id} className="flex min-h-11 items-center justify-between gap-3 py-1">
          <span className="min-w-0 truncate text-foreground">{item.name}</span>
          <span className="shrink-0 text-xs">{item.status === "reconnect_needed" ? "Reconnect needed" : item.status === "disabled" ? "Off" : "Tools not checked"}</span>
        </li>)}
      </ul> : manage && experience.provider === "custom" ? <p>No custom connectors saved.</p> : null}
      {!manage ? <p>One will use only the access you approve. Connecting does not share information with anyone.</p> : null}
      {onOpenConnections ? (
        <Button
          type="button"
          variant="muted"
          size="compact"
          onClick={(event) => onOpenConnections(experience.provider, event.currentTarget)}
        >
          {manage ? experience.provider === "custom" ? "Open connectors" : `Manage ${label}` : `Connect ${label}`}
        </Button>
      ) : null}
    </section>
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
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!user) return;
    void gmail.refreshStatus().catch(() => undefined);
  }, [user?.uid, gmail.refreshStatus]);
  useEffect(() => {
    if (confirmOwner && confirmOwner !== user?.uid) setConfirm(false);
  }, [confirmOwner, user?.uid]);
  const connected = Boolean(gmail.status?.connected && !gmail.status?.needs_reauth);
  const action = connected ? "Disconnect Gmail" : gmail.status?.needs_reauth ? "Reconnect Gmail" : "Connect Gmail";
  return <section aria-label="Gmail connection" className="min-w-0 max-w-xl space-y-3 rounded-2xl border border-border bg-card p-3 text-sm sm:p-4">
    <p role="status" className="font-medium text-foreground">Gmail · {gmail.loadingStatus && !gmail.status ? "Checking" : connected ? "Connected" : gmail.status?.needs_reauth ? "Reconnect needed" : "Not connected"}</p>
    {!connected ? <p className="text-muted-foreground">Connecting does not share information with anyone.</p> : null}
    <Button type="button" variant="muted" size="compact" disabled={busy || !user || (!connected && !onOpenConnections) || (gmail.loadingStatus && !gmail.status)}
      onClick={event => { if (connected) { setConfirmOwner(user?.uid ?? null); setConfirm(true); } else onOpenConnections?.("gmail", event.currentTarget); }}>{action}</Button>
    {error ? <p role="alert">Could not disconnect Gmail. Check and retry.</p> : null}
    <AlertDialog open={confirm} onOpenChange={setConfirm}><AlertDialogContent size="sm"><AlertDialogHeader>
      <AlertDialogTitle>Disconnect Gmail?</AlertDialogTitle>
      <AlertDialogDescription>One will no longer read your Gmail through this connection. This does not revoke access in your Google Account.</AlertDialogDescription>
    </AlertDialogHeader><AlertDialogFooter><AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
      <AlertDialogAction disabled={busy} onClick={event => {
        event.preventDefault();
        if (!confirmOwner || confirmOwner !== user?.uid || !connected) { setConfirm(false); return; }
        setBusy(true); setError(false);
        void gmail.disconnectGmail().then(result => {
          if (!result || result.connected) throw new Error("disconnect_failed");
          setConfirm(false);
        }).catch(() => setError(true)).finally(() => setBusy(false));
      }}>Disconnect Gmail</AlertDialogAction>
    </AlertDialogFooter></AlertDialogContent></AlertDialog>
  </section>;
}
