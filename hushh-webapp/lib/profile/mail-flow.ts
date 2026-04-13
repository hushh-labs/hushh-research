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

export interface GmailStatusSummary {
  tone: "loading" | "success" | "error" | "neutral";
  title: string;
  detail: string;
  helper: string | null;
}

const GMAIL_OAUTH_RETURN_STATUS_KEY = "profile_gmail_oauth_return_status";
const GMAIL_GENERIC_SYNC_ERROR =
  "Something went wrong while syncing your emails. Please try again in a moment.";
const GMAIL_GENERIC_CONNECTION_ERROR =
  "We couldn't check your Gmail connection right now. Please try again in a moment.";
const TECHNICAL_ERROR_PATTERNS = [
  "psycopg2",
  "sqlalchemy",
  "server closed the connection unexpectedly",
  "connection refused",
  "db operation failed",
  "raw_sql",
  "traceback",
  "exception",
  "stack trace",
  "fetch failed",
  "headers timeout",
  "timeouterror",
  "temporarily unavailable",
  "invalid_request_error",
  "undefined",
  "nullreference",
  "syntaxerror",
  "background on this error at",
];

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

function formatRelativeTimeFromNow(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  const diffMs = date.getTime() - Date.now();
  const diffMinutes = Math.round(diffMs / (60 * 1000));
  if (Math.abs(diffMinutes) < 1) {
    return "just now";
  }

  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (Math.abs(diffMinutes) < 60) {
    return formatter.format(diffMinutes, "minute");
  }

  const diffHours = Math.round(diffMinutes / 60);
  if (Math.abs(diffHours) < 24) {
    return formatter.format(diffHours, "hour");
  }

  const diffDays = Math.round(diffHours / 24);
  return formatter.format(diffDays, "day");
}

function hasActiveSync(status: GmailConnectionStatus | null): boolean {
  if (!status) return false;
  const active =
    status.last_sync_status === "running" ||
    status.latest_run?.status === "queued" ||
    status.latest_run?.status === "running";
  return active && !isBackfillRunning(status);
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
    run?.completed_at ||
    run?.started_at ||
    run?.requested_at ||
    status?.last_sync_at ||
    null
  );
}

export function resolveGmailConnectedLabel(status: GmailConnectionStatus | null): string {
  return status?.google_email ? `Connected to ${status.google_email}` : "Connected to your Gmail";
}

export function sanitizeGmailUserMessage(
  value: unknown,
  options?: {
    fallback?: string;
    authFallback?: string;
  }
): string {
  const fallback = options?.fallback || GMAIL_GENERIC_SYNC_ERROR;
  const authFallback =
    options?.authFallback || "Reconnect Gmail to continue syncing your receipts.";
  const raw =
    typeof value === "string"
      ? value
      : value instanceof Error
        ? value.message
        : "";
  const trimmed = raw.trim();

  if (!trimmed) {
    return fallback;
  }

  if (isAuthErrorText(trimmed)) {
    return authFallback;
  }

  const normalized = normalizeText(trimmed);
  if (
    TECHNICAL_ERROR_PATTERNS.some((pattern) => normalized.includes(pattern)) ||
    trimmed.length > 180
  ) {
    return fallback;
  }

  return trimmed;
}

export function resolveGmailLastUpdatedLabel(
  status: GmailConnectionStatus | null,
  run?: GmailSyncRun | null
): string | null {
  const timestamp = latestSyncTimestamp(run ?? status?.latest_run, status);
  if (!timestamp) return null;
  const relative = formatRelativeTimeFromNow(timestamp);
  if (relative) {
    return `Last updated ${relative}.`;
  }
  const absolute = formatDateTime(timestamp);
  return absolute ? `Last updated ${absolute}.` : null;
}

export function resolveGmailStatusSummary(options: {
  status: GmailConnectionStatus | null;
  loading?: boolean;
  errorText?: string | null;
}): GmailStatusSummary {
  const { status, loading = false, errorText = null } = options;
  const connected = Boolean(status?.configured && status?.connected && !status?.revoked);
  const connectedLabel = resolveGmailConnectedLabel(status);
  const lastUpdated = resolveGmailLastUpdatedLabel(status);

  if (loading && !status && !errorText) {
    return {
      tone: "loading",
      title: "Checking your Gmail connection",
      detail: "This should only take a moment.",
      helper: null,
    };
  }

  if (status?.configured === false) {
    return {
      tone: "neutral",
      title: "Gmail sync isn't available here",
      detail: "This workspace isn't set up for Gmail receipt sync yet.",
      helper: null,
    };
  }

  if (!connected && (status?.revoked || status?.needs_reauth || isAuthErrorText(errorText))) {
    return {
      tone: "error",
      title: "Reconnect Gmail to keep syncing receipts",
      detail: "Your Gmail permission needs to be refreshed before we can import new receipts.",
      helper: lastUpdated,
    };
  }

  if (connected && isBackfillRunning(status)) {
    return {
      tone: "success",
      title: "Older receipts are still loading",
      detail: "Your recent receipts are ready while we fetch older receipts in the background.",
      helper: lastUpdated || connectedLabel,
    };
  }

  if (connected && (hasActiveSync(status) || isBootstrapRunning(status))) {
    return {
      tone: "loading",
      title: "Syncing your receipts…",
      detail: "We're fetching your recent purchases.",
      helper: lastUpdated || connectedLabel,
    };
  }

  if (connected && (status?.last_sync_status === "failed" || errorText)) {
    return {
      tone: "error",
      title: "We couldn't sync your receipts",
      detail: sanitizeGmailUserMessage(errorText, {
        fallback: "Please try again in a moment.",
        authFallback: "Reconnect Gmail to continue syncing your receipts.",
      }),
      helper: connectedLabel,
    };
  }

  if (connected) {
    return {
      tone: "success",
      title: lastUpdated ? "Your receipts are up to date" : "Your Gmail is connected",
      detail: connectedLabel,
      helper: lastUpdated || "Sync receipts to bring in your recent purchases.",
    };
  }

  if (errorText) {
    return {
      tone: "error",
      title: "We couldn't check your Gmail connection",
      detail: sanitizeGmailUserMessage(errorText, {
        fallback: GMAIL_GENERIC_CONNECTION_ERROR,
        authFallback: "Reconnect Gmail to continue syncing your receipts.",
      }),
      helper: null,
    };
  }

  return {
    tone: "neutral",
    title: "Connect Gmail to sync your receipts",
    detail: "We'll look for receipt emails and keep them together in one place.",
    helper: null,
  };
}

function resolveLatestSyncText(status: GmailConnectionStatus | null): string {
  const run = status?.latest_run;
  const lastUpdated = resolveGmailLastUpdatedLabel(status, run);

  if (run?.status === "queued") {
    return "Syncing your receipts now.";
  }
  if (run?.status === "running") {
    return "Syncing your receipts now.";
  }
  if (run?.status === "completed") {
    return lastUpdated || "Your receipts are up to date.";
  }
  if (run?.status === "failed") {
    return "We couldn't update your receipts.";
  }
  if (status?.last_sync_status === "failed") {
    return "We couldn't update your receipts.";
  }
  if (status?.last_sync_at) {
    return lastUpdated || "Your receipts are up to date.";
  }
  if (
    status?.bootstrap_state === "running" ||
    status?.bootstrap_state === "queued" ||
    status?.sync_state === "bootstrap_running" ||
    run?.trigger_source === "connect"
  ) {
    return "We're fetching your recent purchases.";
  }
  if (status?.sync_state === "backfill_running" || run?.sync_mode === "backfill") {
    return "We're fetching older receipts in the background.";
  }
  if (status?.connected && !status.revoked) {
    return "Ready to sync your receipts.";
  }
  return "Connect Gmail to start syncing receipts.";
}

export function resolveGmailConnectionPresentation(options: {
  status: GmailConnectionStatus | null;
  loading?: boolean;
  action?: GmailConnectionAction;
  errorText?: string | null;
}): GmailConnectionPresentation {
  const { status, loading = false, action = null, errorText = null } = options;
  const connected = Boolean(status?.configured && status?.connected && !status?.revoked);

  if (loading && !status && !errorText) {
    return {
      state: "loading",
      badgeLabel: "Checking",
      description: "Checking your Gmail connection…",
      latestSyncText: "Loading the latest connection details.",
      latestSyncBadge: null,
      isConnected: false,
    };
  }

  if (action === "connect") {
    return {
      state: "connecting",
      badgeLabel: "Connecting",
      description: "Opening Google so you can connect Gmail.",
      latestSyncText: resolveLatestSyncText(status),
      latestSyncBadge: status?.latest_run?.status || null,
      isConnected: connected,
    };
  }

  if (connected && isBackfillRunning(status)) {
    return {
      state: "connected_backfill_running",
      badgeLabel: "Connected",
      description: `${resolveGmailConnectedLabel(status)}. We're fetching older receipts in the background.`,
      latestSyncText: resolveLatestSyncText(status),
      latestSyncBadge: status?.latest_run?.status || status?.last_sync_status || "running",
      isConnected: true,
    };
  }

  if (hasActiveSync(status)) {
    return {
      state: "syncing",
      badgeLabel: "Syncing",
      description: connected
        ? `${resolveGmailConnectedLabel(status)}. We're syncing your receipts now.`
        : "We're syncing your receipts now.",
      latestSyncText: resolveLatestSyncText(status),
      latestSyncBadge: status?.latest_run?.status || status?.last_sync_status || null,
      isConnected: connected,
    };
  }

  if (status?.configured === false) {
    return {
      state: "not_configured",
      badgeLabel: "Unavailable",
      description: "Gmail sync isn't available in this environment yet.",
      latestSyncText: "Connection isn't available here yet.",
      latestSyncBadge: null,
      isConnected: false,
    };
  }

  if (!connected && (status?.revoked || status?.needs_reauth || isAuthErrorText(errorText))) {
    return {
      state: "needs_reauthentication",
      badgeLabel: "Reconnect Gmail",
      description: "Reconnect Gmail to continue syncing your receipts.",
      latestSyncText: resolveLatestSyncText(status),
      latestSyncBadge: status?.latest_run?.status || status?.last_sync_status || null,
      isConnected: false,
    };
  }

  if (connected && isBootstrapRunning(status)) {
    return {
      state: "connected_initial_scan_running",
      badgeLabel: "Syncing",
      description: `${resolveGmailConnectedLabel(status)}. We're fetching your recent purchases.`,
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
        ? `${resolveGmailConnectedLabel(status)}. We're syncing your receipts now.`
        : "We're syncing your receipts now.",
      latestSyncText: resolveLatestSyncText(status),
      latestSyncBadge: status?.latest_run?.status || status?.last_sync_status || null,
      isConnected: connected,
    };
  }

  if (connected && status?.last_sync_status === "failed") {
    return {
      state: "sync_failed",
      badgeLabel: "Try again",
      description: `${resolveGmailConnectedLabel(status)}. We couldn't update your receipts.`,
      latestSyncText: resolveLatestSyncText(status),
      latestSyncBadge: status?.latest_run?.status || "failed",
      isConnected: true,
    };
  }

  if (connected) {
    return {
      state: "connected",
      badgeLabel: "Connected",
      description: resolveGmailConnectedLabel(status),
      latestSyncText: resolveLatestSyncText(status),
      latestSyncBadge: status?.latest_run?.status || null,
      isConnected: true,
    };
  }

  if (errorText) {
    return {
      state: isAuthErrorText(errorText) ? "needs_reauthentication" : "sync_failed",
      badgeLabel: isAuthErrorText(errorText) ? "Reconnect Gmail" : "Try again",
      description: isAuthErrorText(errorText)
        ? "Reconnect Gmail to continue syncing your receipts."
        : "We couldn't check your Gmail connection. Please try again in a moment.",
      latestSyncText: resolveLatestSyncText(status),
      latestSyncBadge: status?.latest_run?.status || null,
      isConnected: false,
    };
  }

  return {
    state: "disconnected",
    badgeLabel: "Not connected",
    description: "Connect Gmail to bring in your receipts.",
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
      message: sanitizeGmailUserMessage(status?.last_sync_error || status?.latest_run?.error_message, {
        fallback: "We couldn't update your receipts. Please try again in a moment.",
        authFallback: "Reconnect Gmail to continue syncing your receipts.",
      }),
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
        message: "We're fetching older receipts in the background.",
      };
    }
    if (status?.latest_run?.status === "running" || status?.latest_run?.status === "queued") {
      return {
        kind: "message",
        message: "We're still syncing your receipts.",
      };
    }
    return {
      kind: "success",
      message: "Receipts updated.",
    };
  }

  return {
    kind: "message",
    message: "We're still syncing your receipts.",
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
