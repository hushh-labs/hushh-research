"use client";

import { SurfaceInset } from "@/components/app-ui/surfaces";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { RefreshCw } from "@/components/icons";
import { MailActionButton as Button } from "./mail-action-button";
import mailStyles from "./mail-workspace.module.css";
import type { GmailStatusSummary } from "@/lib/profile/mail-flow";

/** The same Mail connection card in Overview, KYC, Receipts, and setup. */
export function MailConnectionStatus({
  statusSummary,
  primaryActionLabel,
  onConnect,
  loadingStatus = false,
  oauthCompletionPending = false,
  isConnected = false,
  busy = false,
  receiptCount,
  receiptSyncInProgress = false,
  isPassiveBackfillState = false,
  hasStaleBackgroundSync = false,
  onRetry,
  connectActionId,
}: {
  statusSummary: GmailStatusSummary;
  primaryActionLabel: string;
  onConnect: () => void;
  loadingStatus?: boolean;
  oauthCompletionPending?: boolean;
  isConnected?: boolean;
  busy?: boolean;
  receiptCount?: number;
  receiptSyncInProgress?: boolean;
  isPassiveBackfillState?: boolean;
  hasStaleBackgroundSync?: boolean;
  onRetry?: () => void;
  connectActionId?: "setup.connect_gmail";
}) {
  // Loading stays neutral while the authoritative connection status resolves.
  const statusToneClassName =
    statusSummary.tone === "success"
      ? "border-emerald-500/18 bg-emerald-500/[0.05]"
      : statusSummary.tone === "error"
        ? "border-rose-500/22 bg-rose-500/[0.06]"
        : "border-border/60 bg-background/68";

  return (
    <SurfaceInset
      data-testid="mail-connection-status"
      className={`space-y-4 border px-4 py-4 text-sm sm:px-5 sm:py-5 ${statusToneClassName}`}
    >
      {loadingStatus ? (
        <div
          aria-busy="true"
          aria-label="Checking your Gmail status"
          className="space-y-3"
        >
          <div className="space-y-1">
            <p className={`${mailStyles.sourceGroup} text-muted-foreground`}>
              Gmail
            </p>
            <h2 className="text-lg font-semibold tracking-tight text-foreground">
              {oauthCompletionPending
                ? "Finishing Gmail connection"
                : "Checking your Gmail status"}
            </h2>
            <p className={`${mailStyles.support} text-muted-foreground`}>
              {oauthCompletionPending
                ? "Your Mail connection is being verified."
                : "Your Mail connection details will appear here when ready."}
            </p>
          </div>
          <div aria-hidden="true" className="space-y-2 pt-1">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-4 w-full max-w-md" />
          </div>
        </div>
      ) : (
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1 space-y-1.5">
            <h2 className="text-lg font-semibold tracking-tight text-foreground">
              {statusSummary.title}
            </h2>
            {statusSummary.detail &&
            (!isConnected || !statusSummary.detail.startsWith("Connected to")) ? (
              <p className={`${mailStyles.support} break-words text-muted-foreground`}>
                {statusSummary.detail}
              </p>
            ) : null}
            {statusSummary.helper ? (
              <p className={`${mailStyles.support} break-words text-muted-foreground`}>
                {statusSummary.helper}
              </p>
            ) : null}
          </div>
          {receiptCount !== undefined ? (
            <Badge variant="secondary" className="shrink-0">
              {receiptCount} receipt{receiptCount === 1 ? "" : "s"}
            </Badge>
          ) : null}
        </div>
      )}

      {receiptSyncInProgress && !isPassiveBackfillState ? (
        <p className={`${mailStyles.support} text-muted-foreground`}>
          Scanning Mail for receipts. Your list will refresh here when it
          finishes.
        </p>
      ) : null}
      {hasStaleBackgroundSync ? (
        <p className={`${mailStyles.support} text-amber-600`}>
          Mail is still running in the background. This status may lag behind for
          a bit.
        </p>
      ) : null}
      {!isConnected && !loadingStatus ? (
        <div className="flex flex-col items-center justify-center gap-2 pt-2 sm:flex-row">
          <Button
            onClick={onConnect}
            disabled={busy}
            className={`${mailStyles.wideAction} w-full max-w-[244px] justify-center text-center`}
            data-voice-control-id="open_gmail_connector"
            data-voice-action-id={
              connectActionId
            }
            data-voice-label={primaryActionLabel}
            data-voice-purpose="starts Mail connection or reconnection from this receipts page."
          >
            {primaryActionLabel}
          </Button>
          {onRetry ? (
            <Button
              variant="none"
              effect="fade"
              onClick={onRetry}
              disabled={busy || loadingStatus}
              className={`${mailStyles.wideAction} w-full max-w-[244px] justify-center text-center`}
              data-voice-control-id="retry_gmail_status"
              data-voice-label="Retry Mail status"
              data-voice-purpose="rechecks the Mail connection without opening Google consent."
            >
              <RefreshCw className="mr-2 h-4 w-4" />
              Retry Mail status
            </Button>
          ) : null}
        </div>
      ) : null}
    </SurfaceInset>
  );
}
