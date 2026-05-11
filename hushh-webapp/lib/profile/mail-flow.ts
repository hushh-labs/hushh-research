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

// --- Types & Constants ---

export type GmailSyncFeedback =
  | { kind: "success"; message: string }
  | { kind: "error"; message: string }
  | { kind: "message"; message: string };

export type GmailConnectionPresentationState =
  | "loading"
  | "not_configured"
  | "disconnected"
  | "connecting"
  | "syncing"
  | "sync_failed"
  | "needs_reauthentication"
  | "connected_backfill_running"
  | "connected_initial_scan_running"
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

const MESSAGES = {
  SYNC_ERROR: "Something went wrong while syncing your emails. Please try again in a moment.",
  CONN_ERROR: "We couldn't check your Gmail connection right now. Please try again in a moment.",
  AUTH_REQUIRED: "Reconnect Gmail to continue syncing your receipts.",
} as const;

const TECHNICAL_ERROR_PATTERNS = [
  "psycopg2", "sqlalchemy", "connection unexpectedly", "connection refused",
  "db operation failed", "raw_sql", "traceback", "exception", "stack trace",
  "fetch failed", "headers timeout", "timeouterror", "temporarily unavailable",
  "invalid_request_error", "undefined", "nullreference", "syntaxerror"
];

// --- Memoized Formatters ---
const DATE_FORMATTER = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

const RELATIVE_FORMATTER = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

// --- Helper Functions ---

function normalizeText(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function isAuthError(value: string | null | undefined): boolean {
  const normalized = normalizeText(value);
  return [
    "invalid_grant", "refresh token", "reauth", "revoked",
    "expired authorization", "permission denied"
  ].some((pattern) => normalized.includes(pattern));
}

function formatRelativeTime(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (isNaN(date.getTime())) return null;

  const diffMs = date.getTime() - Date.now();
  const diffMin = Math.round(diffMs / 60000);

  if (Math.abs(diffMin) < 1) return "just now";
  if (Math.abs(diffMin) < 60) return RELATIVE_FORMATTER.format(diffMin, "minute");

  const diffHours = Math.round(diffMin / 60);
  if (Math.abs(diffHours) < 24) return RELATIVE_FORMATTER.format(diffHours, "hour");

  return RELATIVE_FORMATTER.format(Math.round(diffHours / 24), "day");
}

// --- Core Logic ---

export function sanitizeGmailUserMessage(
  value: unknown,
  options?: { fallback?: string; authFallback?: string }
): string {
  const raw = value instanceof Error ? value.message : String(value ?? "");
  const trimmed = raw.trim();

  if (!trimmed) return options?.fallback ?? MESSAGES.SYNC_ERROR;
  if (isAuthError(trimmed)) return options?.authFallback ?? MESSAGES.AUTH_REQUIRED;

  const normalized = trimmed.toLowerCase();
  const isTechnical = TECHNICAL_ERROR_PATTERNS.some(p => normalized.includes(p)) || trimmed.length > 180;

  return isTechnical ? (options?.fallback ?? MESSAGES.SYNC_ERROR) : trimmed;
}

export function resolveGmailLastUpdatedLabel(
  status: GmailConnectionStatus | null,
  run?: GmailSyncRun | null
): string | null {
  const ts = run?.completed_at || run?.started_at || status?.last_sync_at;
  if (!ts) return null;

  const relative = formatRelativeTime(ts);
  return relative ? `Last updated ${relative}.` : null;
}

export function resolveGmailStatusSummary(options: {
  status: GmailConnectionStatus | null;
  loading?: boolean;
  errorText?: string | null;
}): GmailStatusSummary {
  const { status, loading, errorText } = options;
  const isConnected = !!(status?.configured && status?.connected && !status?.revoked);
  const needsAuth = !isConnected && (status?.revoked || status?.needs_reauth || isAuthError(errorText));

  if (loading && !status) {
    return { tone: "loading", title: "Checking connection", detail: "Please wait...", helper: null };
  }

  if (status?.configured === false) {
    return { tone: "neutral", title: "Sync unavailable", detail: "Workspace not set up.", helper: null };
  }

  if (needsAuth) {
    return {
      tone: "error",
      title: "Reconnect Gmail",
      detail: MESSAGES.AUTH_REQUIRED,
      helper: resolveGmailLastUpdatedLabel(status),
    };
  }

  if (isConnected) {
    const isSyncing = status.last_sync_status === "running" || status.latest_run?.status === "running";
    return {
      tone: isSyncing ? "loading" : "success",
      title: isSyncing ? "Syncing receipts..." : "Receipts up to date",
      detail: status.google_email ? `Connected to ${status.google_email}` : "Gmail connected",
      helper: resolveGmailLastUpdatedLabel(status) ?? "Ready to sync.",
    };
  }

  return {
    tone: "neutral",
    title: "Connect Gmail",
    detail: "Sync your receipts automatically.",
    helper: null,
  };
}

// --- Storage Handlers ---

export function stashProfileGmailReturnStatus(status: GmailConnectionStatus): void {
  try {
    setSessionItem(GMAIL_OAUTH_RETURN_STATUS_KEY, JSON.stringify(status));
  } catch (e) {
    console.error("Failed to stash Gmail status", e);
  }
}

export function consumeProfileGmailReturnStatus(): GmailConnectionStatus | null {
  const raw = getSessionItem(GMAIL_OAUTH_RETURN_STATUS_KEY);
  if (!raw) return null;
  removeSessionItem(GMAIL_OAUTH_RETURN_STATUS_KEY);
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function buildProfileGmailReturnPath(): string {
  return `${ROUTES.PROFILE}?panel=gmail`;
}