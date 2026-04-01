import type {
  GmailConnectionState,
  GmailConnectionStatus,
  GmailSyncRun,
} from "@/lib/services/gmail-receipts-service";
import { ROUTES } from "@/lib/navigation/routes";
import {
  getSessionItem,
  removeSessionItem,
  setSessionItem,
} from "@/lib/utils/session-storage";

export type GmailSyncFeedback =
  | { kind: "success"; message: string }
  | { kind: "error"; message: string }
  | { kind: "message"; message: string };

export type GmailConnectionPresentationState =
  | "loading"
  | "not_configured"
  | "disconnected"
  | GmailConnectionState;

export type GmailConnectionAction = "connect" | "disconnect" | "sync" | null;

export interface GmailConnectionPresentation {
  state: GmailConnectionPresentationState;
  badgeLabel: string;
  description: string;
  latestSyncText: string;
  latestSyncBadge: string | null;
  isConnected: boolean;
}

const GMAIL_OAUTH_RETURN_STATUS_KEY = "profile_gmail_oauth_return_status";

function normalizeText(value: string | null | undefined): string {
  return (value || "").trim().toLowerCase();
}

function formatDateTime(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function hasActiveSync(status: GmailConnectionStatus | null): boolean {
  if (!status) return false;
  return (
    status.last_sync_status === "running" ||
    status.latest_run?.status === "queued" ||
    status.latest_run?.status === "running"
  );
}

function isBootstrapRunning(status: GmailConnectionStatus | null): boolean {
  if (!status) return false;
  return (
    status.bootstrap_state === "queued" ||
    status.bootstrap_state === "running" ||
    status.latest_run?.trigger_source === "connect"
  );
}

function isBackfillRunning(status: GmailConnectionStatus | null): boolean {
  if (!status) return false;
  return (
    status.sync_state === "backfill_running" ||
    status.latest_run?.sync_mode === "backfill" ||
    status.latest_run?.trigger_source === "auto_daily"
  );
}

function isAuthErrorText(value: string | null | undefined): boolean {
  const normalized = normalizeText(value);
  return [
    "invalid_grant",
    "refresh token",
    "reauth",
    "re-auth",
    "revoked",
    "expired authorization",
    "permission denied",
  ].some((pattern) => normalized.includes(pattern));
}

function latestSyncTimestamp(
  run: GmailSyncRun | null | undefined,
  status: GmailConnectionStatus | null
): string | null {
  return (
    formatDateTime(run?.completed_at) ||
    formatDateTime(run?.started_at) ||
    formatDateTime(run?.requested_at) ||
    formatDateTime(status?.last_sync_at) ||
    null
  );
}

function resolveLatestSyncText(status: GmailConnectionStatus | null): string {
  const run = status?.latest_run;
  const timestamp = latestSyncTimestamp(run, status);

  if (run?.status === "queued") {
    return timestamp ? `Sync queued ${timestamp}.` : "Sync queued.";
  }
  if (run?.status === "running") {
    return timestamp ? `Sync started ${timestamp}.` : "Sync in progress.";
  }
  if (run?.status === "completed") {
    return timestamp ? `Last sync completed ${timestamp}.` : "Last sync completed.";
  }
  if (run?.status === "failed") {
    return timestamp ? `Last sync failed ${timestamp}.` : "Last sync failed.";
  }
  if (status?.last_sync_status === "failed") {
    return timestamp ? `Last sync failed ${timestamp}.` : "Last sync failed.";
  }
  if (status?.last_sync_at) {
    const lastSync = formatDateTime(status.last_sync_at);
    return lastSync ? `Last sync: ${lastSync}.` : "Last sync finished recently.";
  }
  if (
    status?.bootstrap_state === "running" ||
    status?.bootstrap_state === "queued" ||
    status?.sync_state === "bootstrap_running" ||
    run?.trigger_source === "connect"
  ) {
    return "Initial Gmail scan is running in the background.";
  }
  if (status?.sync_state === "backfill_running" || run?.sync_mode === "backfill") {
    return "Older Gmail receipts are still being backfilled in the background.";
  }
  if (status?.connected && !status.revoked) {
    return "No sync has finished yet.";
  }
  return "No sync has run yet.";
}

export function resolveGmailConnectionPresentation(options: {
  status: GmailConnectionStatus | null;
  loading?: boolean;
  action?: GmailConnectionAction;
  errorText?: string | null;
}): GmailConnectionPresentation {
  const { status, loading = false, action = null, errorText = null } = options;
  const connected = Boolean(status?.configured && status?.connected && !status?.revoked);
  const connectedEmail = status?.google_email || "your Google account";

  if (loading && !status && !errorText) {
    return {
      state: "loading",
      badgeLabel: "Checking",
      description: "Checking Gmail connector status...",
      latestSyncText: "Loading the latest connection details.",
      latestSyncBadge: null,
      isConnected: false,
    };
  }

  if (action === "connect") {
    return {
      state: "connecting",
      badgeLabel: "Connecting",
      description: "Redirecting to Google to finish Gmail receipt access.",
      latestSyncText: resolveLatestSyncText(status),
      latestSyncBadge: status?.latest_run?.status || null,
      isConnected: connected,
    };
  }

  if (hasActiveSync(status)) {
    return {
      state: "syncing",
      badgeLabel: "Syncing",
      description: connected
        ? `Connected as ${connectedEmail}. Gmail sync is in progress.`
        : "Gmail sync is in progress.",
      latestSyncText: resolveLatestSyncText(status),
      latestSyncBadge: status?.latest_run?.status || status?.last_sync_status || null,
      isConnected: connected,
    };
  }

  if (status?.configured === false) {
    return {
      state: "not_configured",
      badgeLabel: "Not configured",
      description: "Gmail connector is not configured for this environment.",
      latestSyncText: "Connection is unavailable until Gmail OAuth is configured.",
      latestSyncBadge: null,
      isConnected: false,
    };
  }

  if (!connected && (status?.revoked || status?.needs_reauth || isAuthErrorText(errorText))) {
    return {
      state: "needs_reauthentication",
      badgeLabel: "Reconnect Gmail",
      description: "Your Gmail session needs to be reconnected before receipts can sync.",
      latestSyncText: resolveLatestSyncText(status),
      latestSyncBadge: status?.latest_run?.status || status?.last_sync_status || null,
      isConnected: false,
    };
  }

  if (connected && isBootstrapRunning(status)) {
    return {
      state: "connected_initial_scan_running",
      badgeLabel: "Scanning",
      description: `Connected as ${connectedEmail}. Initial Gmail scan is running in the background.`,
      latestSyncText: resolveLatestSyncText(status),
      latestSyncBadge: status?.latest_run?.status || status?.last_sync_status || "running",
      isConnected: true,
    };
  }

  if (connected && isBackfillRunning(status)) {
    return {
      state: "connected_backfill_running",
      badgeLabel: "Backfilling",
      description: `Connected as ${connectedEmail}. Older Gmail receipts are still backfilling in the background.`,
      latestSyncText: resolveLatestSyncText(status),
      latestSyncBadge: status?.latest_run?.status || status?.last_sync_status || "running",
      isConnected: true,
    };
  }

  if (action === "sync" || hasActiveSync(status)) {
    return {
      state: "syncing",
      badgeLabel: "Syncing",
      description: connected
        ? `Connected as ${connectedEmail}. Gmail sync is in progress.`
        : "Gmail sync is in progress.",
      latestSyncText: resolveLatestSyncText(status),
      latestSyncBadge: status?.latest_run?.status || status?.last_sync_status || null,
      isConnected: connected,
    };
  }

  if (connected && status?.last_sync_status === "failed") {
    return {
      state: "sync_failed",
      badgeLabel: "Needs attention",
      description: `Connected as ${connectedEmail}. The latest sync needs attention.`,
      latestSyncText: resolveLatestSyncText(status),
      latestSyncBadge: status?.latest_run?.status || "failed",
      isConnected: true,
    };
  }

  if (connected) {
    return {
      state: "connected",
      badgeLabel: "Connected",
      description: `Connected as ${connectedEmail}.`,
      latestSyncText: resolveLatestSyncText(status),
      latestSyncBadge: status?.latest_run?.status || null,
      isConnected: true,
    };
  }

  if (errorText) {
    return {
      state: isAuthErrorText(errorText) ? "needs_reauthentication" : "sync_failed",
      badgeLabel: "Needs attention",
      description: isAuthErrorText(errorText)
        ? "We couldn't refresh Gmail auth. Reconnect to continue syncing receipts."
        : "We couldn't confirm your Gmail connection. Retry or reconnect to continue.",
      latestSyncText: resolveLatestSyncText(status),
      latestSyncBadge: status?.latest_run?.status || null,
      isConnected: false,
    };
  }

  return {
    state: "disconnected",
    badgeLabel: "Not connected",
    description: "Connect Gmail to sync receipt emails into Kai.",
    latestSyncText: resolveLatestSyncText(status),
    latestSyncBadge: status?.latest_run?.status || null,
    isConnected: false,
  };
}

export function buildProfileGmailReturnPath(): string {
  const params = new URLSearchParams({
    tab: "account",
    panel: "gmail",
  });
  return `${ROUTES.PROFILE}?${params.toString()}`;
}

export function stashProfileGmailReturnStatus(status: GmailConnectionStatus): void {
  try {
    setSessionItem(GMAIL_OAUTH_RETURN_STATUS_KEY, JSON.stringify(status));
  } catch (error) {
    console.warn("[mail-flow] Failed to persist Gmail return status:", error);
  }
}

export function consumeProfileGmailReturnStatus(): GmailConnectionStatus | null {
  const raw = getSessionItem(GMAIL_OAUTH_RETURN_STATUS_KEY);
  if (!raw) return null;

  removeSessionItem(GMAIL_OAUTH_RETURN_STATUS_KEY);

  try {
    return JSON.parse(raw) as GmailConnectionStatus;
  } catch (error) {
    console.warn("[mail-flow] Failed to parse Gmail return status:", error);
    return null;
  }
}

export function resolveGmailSyncFeedback(
  status: GmailConnectionStatus | null
): GmailSyncFeedback {
  const latestRunStatus = status?.latest_run?.status;
  const terminalStatus = latestRunStatus || status?.last_sync_status;

  if (terminalStatus === "failed" || status?.last_sync_status === "failed") {
    return {
      kind: "error",
      message: status?.last_sync_error || status?.latest_run?.error_message || "Gmail sync failed.",
    };
  }

  if (terminalStatus === "canceled" || status?.last_sync_status === "canceled") {
    return {
      kind: "message",
      message: "Gmail sync was canceled.",
    };
  }

  if (
    terminalStatus === "completed" ||
    status?.last_sync_status === "completed" ||
    status?.bootstrap_state === "running" ||
    status?.bootstrap_state === "queued" ||
    status?.sync_state === "bootstrap_running" ||
    status?.sync_state === "backfill_running" ||
    status?.latest_run?.status === "running" ||
    status?.latest_run?.status === "queued"
  ) {
    if (
      status?.bootstrap_state === "running" ||
      status?.bootstrap_state === "queued" ||
      status?.sync_state === "bootstrap_running"
    ) {
      return {
        kind: "message",
        message: "Gmail is scanning recent receipts in the background.",
      };
    }
    if (status?.sync_state === "backfill_running") {
      return {
        kind: "message",
        message: "Gmail is backfilling older receipts in the background.",
      };
    }
    if (status?.latest_run?.status === "running" || status?.latest_run?.status === "queued") {
      return {
        kind: "message",
        message: "Gmail sync is still running in the background.",
      };
    }
    return {
      kind: "success",
      message: "Gmail receipts synced.",
    };
  }

  return {
    kind: "message",
    message: "Gmail sync is still running. Check back in a moment.",
  };
}

export function isRecoverableGmailOAuthReplayError(error: unknown): boolean {
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const normalized = normalizeText(message);

  if (!normalized) return false;

  return [
    "oauth state expired",
    "invalid oauth state token",
    "invalid oauth state signature",
    "oauth state verification failed",
    "invalid_grant",
    "code has already been used",
  ].some((pattern) => normalized.includes(pattern));
}
