import type {
  GmailConnectionStatus,
  GmailSyncRun,
} from "@/lib/services/gmail-receipts-service";

// 1. Singleton Pattern for Formatters (Memory Save)
// Global-ah oru thadava create panna pothum
const formatters = {
  date: new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }),
  relative: new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }),
};

export type GmailSyncFeedback =
  | { kind: "success"; message: string }
  | { kind: "error"; message: string }
  | { kind: "message"; message: string };

export type GmailConnectionAction = "connect" | "disconnect" | "sync" | null;

export interface GmailStatusSummary {
  tone: "loading" | "success" | "error" | "neutral";
  title: string;
  detail: string;
  helper: string | null;
}

// 2. Constants-ah oru Object-la grouped-ah vachukonga
const GMAIL_MESSAGES = {
  ERRORS: {
    GENERIC_SYNC: "Something went wrong while syncing your emails. Please try again in a moment.",
    GENERIC_CONN: "We couldn't check your Gmail connection right now.",
    AUTH_FALLBACK: "Reconnect Gmail to continue syncing your receipts.",
  },
  LOADING: {
    SYNCING: "Syncing your receipts now...",
    FETCHING: "We're fetching your recent purchases.",
  }
} as const;

// 3. Type Guard: Check if it's an Auth Error
// Ithu true-na TS automatic-ah logic-ah purinjukum
function isAuthError(value: string | null | undefined): boolean {
  if (!value) return false;
  const patterns = ["invalid_grant", "refresh token", "reauth", "revoked", "expired"];
  const normalized = value.toLowerCase();
  return patterns.some(p => normalized.includes(p));
}

function formatDateTime(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return formatters.date.format(date);
}

function formatRelativeTimeFromNow(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  const diffMs = date.getTime() - Date.now();
  const diffMinutes = Math.round(diffMs / (60 * 1000));
  if (Math.abs(diffMinutes) < 1) return "just now";

  if (Math.abs(diffMinutes) < 60) {
    return formatters.relative.format(diffMinutes, "minute");
  }

  const diffHours = Math.round(diffMinutes / 60);
  if (Math.abs(diffHours) < 24) {
    return formatters.relative.format(diffHours, "hour");
  }

  const diffDays = Math.round(diffHours / 24);
  return formatters.relative.format(diffDays, "day");
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

export function resolveGmailLastUpdatedLabel(
  status: GmailConnectionStatus | null,
  run?: GmailSyncRun | null
): string | null {
  const timestamp = latestSyncTimestamp(run ?? status?.latest_run, status);
  if (!timestamp) return null;
  const relative = formatRelativeTimeFromNow(timestamp);
  if (relative) return `Last updated ${relative}.`;
  const absolute = formatDateTime(timestamp);
  return absolute ? `Last updated ${absolute}.` : null;
}

// 4. Object Literal Lookup (Cleanest way to replace Switch/If-Else)
const STATUS_TO_TEXT_MAP: Record<string, string> = {
  queued: "Syncing your receipts now.",
  running: "Syncing your receipts now.",
  failed: "We couldn't update your receipts.",
  completed: "Your receipts are up to date.",
};

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

// 5. Improved sanitize function with Array.prototype.some logic
export function sanitizeGmailUserMessage(
  value: unknown,
  options: { fallback?: string; authFallback?: string } = {}
): string {
  const raw = value instanceof Error ? value.message : String(value ?? "");
  const trimmed = raw.trim();

  if (!trimmed) return options.fallback ?? GMAIL_MESSAGES.ERRORS.GENERIC_SYNC;
  if (isAuthError(trimmed)) return options.authFallback ?? GMAIL_MESSAGES.ERRORS.AUTH_FALLBACK;

  // Faster technical error check
  const isTechnical = TECHNICAL_ERROR_PATTERNS.some(p => trimmed.toLowerCase().includes(p));

  return (isTechnical || trimmed.length > 180)
    ? (options.fallback ?? GMAIL_MESSAGES.ERRORS.GENERIC_SYNC)
    : trimmed;
}

// 6. Use 'Optional Chaining' and 'Nullish Coalescing' effectively
export function resolveGmailStatusSummary(options: {
  status: GmailConnectionStatus | null;
  loading?: boolean;
  errorText?: string | null;
}): GmailStatusSummary {
  const { status, loading, errorText } = options;

  // Early Exit for Not Configured (Optimization)
  if (status?.configured === false) {
    return {
      tone: "neutral",
      title: "Gmail sync isn't available here",
      detail: "This workspace isn't set up for Gmail receipt sync yet.",
      helper: null,
    };
  }

  const isConnected = !!(status?.connected && !status?.revoked);
  const authIssue = !isConnected && (status?.revoked || status?.needs_reauth || isAuthError(errorText));

  // Pattern Matching Logic
  if (authIssue) {
    return {
      tone: "error",
      title: "Reconnect Gmail",
      detail: GMAIL_MESSAGES.ERRORS.AUTH_FALLBACK,
      helper: resolveGmailLastUpdatedLabel(status),
    };
  }

  // Final Success Fallback
  if (isConnected) {
    return {
      tone: "success",
      title: "Your receipts are up to date",
      detail: resolveGmailConnectedLabel(status),
      helper: resolveGmailLastUpdatedLabel(status) ?? "Sync receipts to see updates.",
    };
  }

  // Default return
  return {
    tone: "neutral",
    title: "Connect Gmail",
    detail: "Collect all your receipts in one place.",
    helper: null,
  };
}