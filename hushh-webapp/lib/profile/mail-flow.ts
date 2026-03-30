import type { GmailConnectionStatus } from "@/lib/services/gmail-receipts-service";
import { ROUTES } from "@/lib/navigation/routes";

export type GmailSyncFeedback =
  | { kind: "success"; message: string }
  | { kind: "error"; message: string }
  | { kind: "message"; message: string };

function normalizeText(value: string | null | undefined): string {
  return (value || "").trim().toLowerCase();
}

export function buildProfileGmailReturnPath(): string {
  const params = new URLSearchParams({
    tab: "account",
    panel: "gmail",
  });
  return `${ROUTES.PROFILE}?${params.toString()}`;
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

  if (terminalStatus === "completed" || status?.last_sync_status === "completed") {
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
