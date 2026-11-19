"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/lib/morphy-ux/button";
import { morphyToast } from "@/lib/morphy-ux/morphy";
import { useAuth } from "@/hooks/use-auth";
import { useGmailConnectorStatus } from "@/lib/profile/gmail-connector-store";
import { useCalendarConnectionStatus } from "@/lib/calendar/use-calendar-connection-status";
import { ApiService } from "@/lib/services/api-service";
import { ExternalConnectorService } from "@/lib/services/external-connector-service";
import { VaultContext } from "@/lib/vault/vault-context";
import { usePkmDomainResource } from "@/lib/pkm/pkm-domain-resource";
import { summarizePlaidVaultProjection } from "@/lib/kai/plaid-vault/projection-summary";
import { syncPlaidPostureToPersonalWikiBestEffort } from "@/lib/kai/plaid-vault/wiki-posture-sync";
import {
  connectVaultPlaid,
  refreshVaultConnections,
  vaultConnections,
} from "@/lib/kai/plaid-vault/vault-sync";
import { openProfilePane } from "@/lib/navigation/profile-pane";
import { ConnectorBrandMark, connectorBrandFor, type ConnectorBrand } from "@/components/agent/connector-brand-mark";
import { ConnectedSystemsAgentIcon } from "@/components/icons";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import type {
  ConnectorReadExperience,
  DriveOwnerCompileWindow,
  WorkspaceConnectorProvider,
  WorkspaceConnectorSetupExperience,
} from "@/lib/agent/connector-read-receipt";
import type { DriveCompilationUiState } from "@/lib/agent/drive-batch-progress";

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
const COMPILATION_ERROR_TEXT: Record<NonNullable<DriveCompilationUiState["errorReason"]>, string> = {
  connect_required: "Connect Drive, then try again.",
  reconnect_required: "Reconnect Drive, then try again.",
  input_required: "This search is out of date or needs a more specific title. Search again in chat.",
  source_changed: "Drive changed during compilation. Try again.",
  interrupted: "Compilation stopped before it finished. Try again.",
  unavailable: "Drive could not finish the compilation. Try again.",
};

export function ConnectorReadReceipt({ experience, onOpenConnections, onCompileDriveNotes,
  onDownloadDriveNotes, driveCompilation }: {
  experience: ConnectorReadExperience;
  onOpenConnections?: (provider: WorkspaceConnectorProvider, trigger: HTMLButtonElement) => void;
  onCompileDriveNotes?: (query: string, window: DriveOwnerCompileWindow) => void;
  onDownloadDriveNotes?: () => void;
  driveCompilation?: DriveCompilationUiState;
}) {
  const needsConnection = ["connect_required", "reconnect_required", "permission_denied"].includes(experience.status);
  const drive = experience.connector === "drive";
  if (!drive && experience.status === "ok" && !experience.truncated) return null;
  return (
    <section aria-label={drive ? "Drive read details" : "Mail read details"} className="min-w-0 space-y-2 text-sm text-muted-foreground">
      {(!drive && experience.status === "ok") ? null : <div className="flex items-center gap-2">
      <ConnectorBrandMark brand={drive ? "drive" : "gmail"} size="sm" />
      <p role="status">{!drive && experience.status === "ok" && !experience.metadataOnly
        ? "Mail messages read"
        : (drive ? DRIVE_STATUS : STATUS_TEXT)[experience.status]}</p>
      </div>}
      {experience.status === "ok" ? (
        <>
          {drive ? <p>{experience.metadataOnly ? "Drive file matches" : "Drive excerpts"} · {experience.sourceRefs.length} cited {experience.sourceRefs.length === 1 ? "source" : "sources"}</p> : null}
          {drive && experience.sourceRefs.length > 0 && !experience.ownerCompileAvailable ? (
            <ul aria-label={drive ? "Document sources" : "Mail sources"} className="flex flex-wrap gap-x-3 gap-y-1">
              {experience.sourceRefs.map((ref, index) => <li key={ref}>{drive ? `${experience.metadataOnly ? "File" : "Document excerpt"} ${index + 1}${experience.sourcePages?.[index] ? ` · page ${experience.sourcePages[index]}` : ""}` : `Mail ${ref.slice(5)}`}</li>)}
            </ul>
          ) : null}
          {experience.truncated ? <p>{experience.metadataOnly ? "Some matches or metadata were omitted." : drive ? "Some document content was omitted." : "Long or older messages were shortened."}</p> : null}
        </>
      ) : null}
      {needsConnection && onOpenConnections ? (
        <Button type="button" variant="muted" size="compact" onClick={(event) => onOpenConnections(drive ? "drive" : "gmail", event.currentTarget)}>
          {experience.status === "connect_required"
            ? `Connect ${drive ? "Drive" : "Gmail"}`
            : `Review ${drive ? "Drive" : "Gmail"} access`}
        </Button>
      ) : null}
      {drive && experience.ownerCompileAvailable && experience.ownerCompileQuery &&
        experience.ownerCompileWindow && onCompileDriveNotes ? (
        <div className="space-y-2">
          {driveCompilation?.status === "ready" || driveCompilation?.status === "partial" ? (
            <p role="status">
              Compiled {driveCompilation.included} of {driveCompilation.matched} matching files.
              {driveCompilation.status === "partial" ? " Some notes were unavailable or omitted." : ""}
            </p>
          ) : null}
          {driveCompilation?.status === "error" ? (
            <p role="status">{COMPILATION_ERROR_TEXT[driveCompilation.errorReason ?? "unavailable"]}</p>
          ) : null}
          {driveCompilation?.status === "ready" || driveCompilation?.status === "partial" ? (
            <Button type="button" variant="muted" size="compact" disabled={!onDownloadDriveNotes}
              onClick={onDownloadDriveNotes}>
              Download Markdown notes
            </Button>
          ) : (
            <Button type="button" variant="muted" size="compact"
              disabled={driveCompilation?.status === "running"}
              onClick={() => onCompileDriveNotes(
                experience.ownerCompileQuery!, experience.ownerCompileWindow!,
              )}>
              {driveCompilation?.status === "running" ? "Compiling original notes…" :
                driveCompilation?.status === "error" ? "Try compiling again" : "Compile original notes"}
            </Button>
          )}
        </div>
      ) : null}
    </section>
  );
}

const WORKSPACE_PROVIDER_LABEL: Record<WorkspaceConnectorProvider, string> = {
  drive: "Drive",
  gmail: "Gmail",
  calendar: "Calendar",
  custom: "Connectors",
  plaid: "Plaid",
  stripe: "Stripe",
};

export type AgentConnectorContinuationHandler = {
  continueAfterConnectorSync: (prompt: string) => void;
};

export const AgentConnectorContinuationContext =
  createContext<AgentConnectorContinuationHandler | null>(null);

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
          {brand ? <ConnectorBrandMark brand={brand} /> : <span aria-hidden="true" className="flex size-8 shrink-0 items-center justify-center"><ConnectedSystemsAgentIcon className="size-5" /></span>}
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
  const { user, userId } = useAuth();
  const vaultOwnerToken = useContext(VaultContext)?.vaultOwnerToken ?? null;
  const idTokenProvider = useCallback(() => user?.getIdToken() ?? Promise.resolve(""), [user]);
  const calendar = useCalendarConnectionStatus({
    userId: provider === "calendar" ? userId : null,
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
  if (experience.provider === "plaid") return <PlaidConnectorChatCard onOpenConnections={onOpenConnections} />;
  if (experience.provider === "stripe") return <StripeConnectorChatCard onOpenConnections={onOpenConnections} />;
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
  const actionLabel = connected ? experience.provider === "calendar" ? "Continue in chat" : `Manage ${label}` : reconnect ? `Reconnect ${label}` : `Connect ${label}`;
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

function PlaidConnectorChatCard({
  onOpenConnections,
}: {
  onOpenConnections?: (provider: WorkspaceConnectorProvider, trigger: HTMLButtonElement) => void;
}) {
  const { userId } = useAuth();
  const vault = useContext(VaultContext);
  const continuation = useContext(AgentConnectorContinuationContext);
  const vaultKey = vault?.vaultKey ?? null;
  const vaultOwnerToken = vault?.vaultOwnerToken ?? null;
  const financial = usePkmDomainResource({
    userId: userId ?? "",
    domain: "financial",
    vaultKey,
    vaultOwnerToken,
    enabled: Boolean(userId && vaultKey && vaultOwnerToken),
  }) as {
    data: { data?: Record<string, unknown> } | null;
    loading: boolean;
    error: string | null;
    refresh?: (options?: { force?: boolean }) => Promise<{ data?: Record<string, unknown> } | null | undefined>;
  };

  const [busyAction, setBusyAction] = useState<"connect" | "refresh" | null>(null);
  const [statusMessage, setStatusMessage] = useState<string>("");
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const connections =
    vaultKey && vaultOwnerToken && financial.data?.data
      ? Object.entries(vaultConnections(financial.data.data))
      : [];
  const projection = summarizePlaidVaultProjection(
    vaultKey && vaultOwnerToken ? financial.data?.data : null,
  );
  const connected = connections.length > 0;
  const hasVaultAccess = Boolean(userId && vaultKey && vaultOwnerToken);
  const needsRelink = connections.some(([, item]) => item.status === "needs_relink");

  const title = !hasVaultAccess
    ? "Plaid · Unlock vault to connect bank accounts"
    : financial.loading && !financial.data
      ? "Plaid · Checking"
      : connected
        ? `Plaid · ${connections.length} connected ${connections.length === 1 ? "institution" : "institutions"}`
        : "Plaid · Connect bank or financial account";

  const detail = statusMessage
    ? statusMessage
    : connected
      ? [
          projection.totalsLine,
          projection.projectedScopesLine,
          needsRelink ? "Reconnect required on at least one institution." : null,
        ]
          .filter(Boolean)
          .join(" · ") || "Connected in your encrypted financial vault."
      : "Link checking, savings, credit card, investment, or loan accounts. Your vault stays encrypted on your device.";

  const handleConnect = async (trigger: HTMLButtonElement) => {
    if (!hasVaultAccess || !userId || !vaultKey || !vaultOwnerToken) {
      onOpenConnections?.("plaid", trigger);
      return;
    }
    setBusyAction("connect");
    setStatusMessage("Opening Plaid Link…");
    try {
      const result = await connectVaultPlaid({
        userId,
        vaultKey,
        vaultOwnerToken,
        originSurface: "agentone_chat",
      });
      if (!mounted.current) return;
      if (result.status === "connected") {
        const refreshed = await financial.refresh?.({ force: true }).catch(() => undefined);
        await syncPlaidPostureToPersonalWikiBestEffort({
          userId,
          vaultKey,
          vaultOwnerToken,
          financial: refreshed?.data ?? financial.data?.data,
        });
        if (!mounted.current) return;
        const label = result.institutionName
          ? `${result.institutionName} connected and synced to your financial scopes & Personal Wiki.`
          : "Bank connected and synced to your financial scopes & Personal Wiki.";
        setStatusMessage(label);
        continuation?.continueAfterConnectorSync(
          result.institutionName
            ? `I just connected ${result.institutionName} with Plaid. Summarize my connected accounts, balances, and updated financial scopes.`
            : "I just connected my bank account with Plaid. Summarize my connected accounts, balances, and updated financial scopes.",
        );
      } else if (result.status === "blocked") {
        setStatusMessage(result.reason);
      } else {
        setStatusMessage("");
      }
    } catch {
      if (mounted.current) setStatusMessage("Could not connect Plaid right now. Try again.");
    } finally {
      if (mounted.current) setBusyAction(null);
    }
  };

  const handleRefresh = async () => {
    if (!hasVaultAccess || !userId || !vaultKey || !vaultOwnerToken) return;
    setBusyAction("refresh");
    setStatusMessage("Refreshing live balances from Plaid…");
    try {
      const outcome = await refreshVaultConnections({
        userId,
        vaultKey,
        vaultOwnerToken,
        financial: financial.data?.data,
        force: true,
      });
      if (!mounted.current) return;
      const refreshed = await financial.refresh?.({ force: true }).catch(() => undefined);
      await syncPlaidPostureToPersonalWikiBestEffort({
        userId,
        vaultKey,
        vaultOwnerToken,
        financial: refreshed?.data ?? financial.data?.data,
      });
      if (!mounted.current) return;
      if (outcome.needsRelink.length > 0) {
        setStatusMessage("One or more institutions need re-authentication.");
      } else if (outcome.refreshed > 0) {
        setStatusMessage("Balances refreshed, financial scopes & Personal Wiki updated.");
        continuation?.continueAfterConnectorSync(
          "I just refreshed my Plaid bank accounts. Summarize my updated balances and confirm my shared scopes updated.",
        );
      } else {
        setStatusMessage("Accounts are already up to date.");
      }
    } catch {
      if (mounted.current) setStatusMessage("Could not refresh balances right now. Try again.");
    } finally {
      if (mounted.current) setBusyAction(null);
    }
  };

  return (
    <ConnectorCardShell
      ariaLabel="Plaid connection"
      brand="plaid"
      title={title}
      detail={detail}
      action={
        <div className="flex flex-wrap items-center gap-2">
          {connected ? (
            <Button
              type="button"
              variant="muted"
              size="compact"
              disabled={busyAction !== null}
              onClick={() => void handleRefresh()}
            >
              {busyAction === "refresh" ? "Refreshing…" : "Refresh now"}
            </Button>
          ) : null}
          <Button
            type="button"
            variant="muted"
            size="compact"
            disabled={busyAction !== null}
            onClick={(event) => void handleConnect(event.currentTarget)}
          >
            {busyAction === "connect" ? "Opening Plaid…" : connected ? "Add bank" : "Connect bank"}
          </Button>
        </div>
      }
    >
      {connections.length > 0 ? (
        <ul className="mt-2 divide-y divide-border/70" aria-label="Connected Plaid institutions">
          {connections.map(([itemId, conn]) => (
            <li key={itemId} className="flex min-h-10 items-center justify-between gap-3 py-1.5 text-xs">
              <span className="min-w-0 truncate font-medium text-foreground">
                {conn.institution_name || "Connected bank"}
              </span>
              <span className="shrink-0 text-muted-foreground">
                {projection.byItemId[itemId]?.summaryLabel ??
                  (conn.status === "needs_relink" ? "Reconnect needed" : "Active")}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </ConnectorCardShell>
  );
}

function StripeConnectorChatCard({
  onOpenConnections,
}: {
  onOpenConnections?: (provider: WorkspaceConnectorProvider, trigger: HTMLButtonElement) => void;
}) {
  const { userId } = useAuth();
  const vault = useContext(VaultContext);
  const vaultOwnerToken = vault?.vaultOwnerToken ?? null;
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [payoutsEnabled, setPayoutsEnabled] = useState(false);
  const [detailsSubmitted, setDetailsSubmitted] = useState(false);
  const [connected, setConnected] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");

  useEffect(() => {
    if (!userId || !vaultOwnerToken) return;
    let cancelled = false;
    setLoading(true);
    void ApiService.apiFetch("/api/one/payouts", {
      method: "GET",
      headers: { Authorization: `Bearer ${vaultOwnerToken}` },
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { account?: { payoutsEnabled?: boolean; detailsSubmitted?: boolean } | null } | null) => {
        if (cancelled || !data) return;
        const account = data.account;
        setConnected(Boolean(account));
        setPayoutsEnabled(Boolean(account?.payoutsEnabled));
        setDetailsSubmitted(Boolean(account?.detailsSubmitted));
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [userId, vaultOwnerToken]);

  const startStripeOnboarding = async (trigger: HTMLButtonElement) => {
    if (!userId || !vaultOwnerToken) {
      onOpenConnections?.("stripe", trigger);
      return;
    }
    setBusy(true);
    setErrorMsg("");
    try {
      const endpoint = connected && detailsSubmitted
        ? "/api/one/payouts/account/manage"
        : "/api/one/payouts/onboard";
      const response = await ApiService.apiFetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${vaultOwnerToken}`,
          "Content-Type": "application/json",
        },
      });
      const data = (await response.json().catch(() => null)) as { url?: string } | null;
      if (response.ok && data?.url && typeof window !== "undefined") {
        window.open(data.url, "_blank", "noopener,noreferrer");
      } else if (typeof window !== "undefined") {
        openProfilePane(window.location.pathname, window.location.search, { panel: "payouts", detail: null }, { returnsToOrigin: true });
      }
    } catch {
      setErrorMsg("Could not open Stripe Connect right now.");
    } finally {
      setBusy(false);
    }
  };

  const statusLabel = loading
    ? "Checking"
    : payoutsEnabled
      ? "Connected"
      : detailsSubmitted
        ? "Setup in progress"
        : connected
          ? "Finish setup"
          : "Not connected";

  return (
    <ConnectorCardShell
      ariaLabel="Stripe connection"
      brand="stripe"
      title={`Stripe · ${statusLabel}`}
      detail={
        errorMsg ||
        (payoutsEnabled
          ? "Stripe Express payouts are ready to receive marketplace and data earnings."
          : "Set up Stripe Connect to receive payouts from shared marketplace requests.")
      }
      action={
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="muted"
            size="compact"
            disabled={busy || loading}
            onClick={(event) => void startStripeOnboarding(event.currentTarget)}
          >
            {busy
              ? "Opening Stripe…"
              : payoutsEnabled
                ? "Manage payouts"
                : connected
                  ? "Continue Stripe setup"
                  : "Set up Stripe"}
          </Button>
          {onOpenConnections ? (
            <Button
              type="button"
              variant="muted"
              size="compact"
              onClick={(event) => onOpenConnections("stripe", event.currentTarget)}
            >
              Connectors
            </Button>
          ) : null}
        </div>
      }
    />
  );
}

function GmailConnectorChatCard({ onOpenConnections }: {
  onOpenConnections?: (provider: WorkspaceConnectorProvider, trigger: HTMLButtonElement) => void;
}) {
  const { user, userId } = useAuth();
  const token = useCallback(() => user?.getIdToken() ?? Promise.resolve(""), [user]);
  const gmail = useGmailConnectorStatus({ userId, idTokenProvider: user ? token : null });
  const [confirm, setConfirm] = useState(false);
  const [confirmOwner, setConfirmOwner] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ownerUid = userId;
  const refreshGmailStatus = gmail.refreshStatus;
  useEffect(() => {
    if (!ownerUid) return;
    void refreshGmailStatus().catch(() => undefined);
  }, [ownerUid, refreshGmailStatus]);
  useEffect(() => {
    if (confirmOwner && confirmOwner !== userId) setConfirm(false);
  }, [confirmOwner, userId]);
  const connected = Boolean(gmail.status?.connected && !gmail.status?.needs_reauth);
  const action = connected ? "Disconnect Gmail" : gmail.status?.needs_reauth ? "Reconnect Gmail" : "Connect Gmail";
  const gmailState = gmail.loadingStatus && !gmail.status ? "Checking" : connected ? "Connected" : gmail.status?.needs_reauth ? "Reconnect needed" : "Not connected";
  return <ConnectorCardShell
    ariaLabel="Gmail connection"
    brand="gmail"
    title={`Gmail · ${gmailState}`}
    detail={!connected ? "Connecting does not share information with anyone." : undefined}
    action={<Button type="button" variant="muted" size="compact" disabled={busy || !user || (!connected && !onOpenConnections) || (gmail.loadingStatus && !gmail.status)}
      onClick={event => { if (connected) { setConfirmOwner(userId); setConfirm(true); } else onOpenConnections?.("gmail", event.currentTarget); }}>{action}</Button>}
  >
    <AlertDialog open={confirm} onOpenChange={setConfirm}><AlertDialogContent size="sm"><AlertDialogHeader>
      <AlertDialogTitle>Disconnect Gmail?</AlertDialogTitle>
      <AlertDialogDescription>One will stop reading Mail and delete its synced Mail receipt data. Information saved to private memory stays. You can also remove app access in your Google Account.</AlertDialogDescription>
    </AlertDialogHeader><AlertDialogFooter><AlertDialogCancel size="standard" className="min-w-0 w-full px-3" disabled={busy}>Cancel</AlertDialogCancel>
      <AlertDialogAction size="standard" className="min-w-0 w-full px-3" aria-label="Disconnect Gmail" disabled={busy} onClick={event => {
        event.preventDefault();
        if (!confirmOwner || confirmOwner !== userId || !connected) { setConfirm(false); return; }
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
