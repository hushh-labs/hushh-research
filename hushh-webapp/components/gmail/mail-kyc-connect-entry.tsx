"use client";

import { SurfaceInset } from "@/components/app-ui/surfaces";
import { MediumRowLabel, RowDescription } from "@/components/app-ui/typography";
import { GmailAgentIcon, CalendarAgentIcon } from "@/components/icons/agents/agent-icons";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { FileText, LockKeyhole, RefreshCw, ShoppingBag } from "@/components/icons";
import { Button } from "@/lib/morphy-ux/button";
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
  // Keep recovery/error detail available; the first connection needs one clear action.
  if (!isConnected && !loadingStatus && statusSummary.tone !== "error" && !onRetry) {
    return (
      <SurfaceInset
        data-testid="mail-connection-status"
        className="grid items-center gap-1.5 overflow-hidden p-3 sm:grid-cols-2 sm:gap-3.5"
      >
        <div aria-hidden="true" className="relative mx-auto flex size-48 items-center justify-center sm:size-60">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/illustrations/mail-connect-envelope.png" alt="" className="absolute inset-0 size-full object-contain" />
          <span className="absolute left-0 top-9 flex size-10 items-center justify-center rounded-xl border border-border/60 bg-card">
            <GmailAgentIcon size={26} />
          </span>
          <span className="absolute right-0 top-3 flex size-10 items-center justify-center rounded-xl border border-border/60 bg-card">
            <CalendarAgentIcon size={26} />
          </span>
          <span className="absolute bottom-3 left-5 flex size-10 items-center justify-center rounded-xl border border-border/60 bg-card text-[color:var(--app-accent)]">
            <FileText className="size-6" />
          </span>
        </div>
        <div className="flex min-w-0 flex-col items-center text-center sm:items-start sm:text-left">
          <MediumRowLabel as="h2" className="!text-base !leading-6">Connect your Mail</MediumRowLabel>
          <RowDescription className="mt-0.5 !text-xs !leading-5">Emails and receipts, together.</RowDescription>
          <ul className="mt-4 w-full space-y-3 text-left">
            {[
              { icon: FileText, title: "Auto-sync receipts", detail: "Find and organize receipts automatically.", tone: "text-emerald-600 bg-emerald-500/10 dark:text-emerald-400" },
              { icon: ShoppingBag, title: "Build shopping memory", detail: "Keep purchases together for useful insights.", tone: "text-violet-600 bg-violet-500/10 dark:text-violet-400" },
              { icon: LockKeyhole, title: "You control access", detail: "Only what you allow. Disconnect anytime.", tone: "text-[color:var(--app-accent)] bg-[color:var(--app-accent-tint)]" },
            ].map(({ icon: Icon, title, detail, tone }) => (
              <li key={title} className="flex items-start gap-3">
                <span className={`flex size-10 shrink-0 items-center justify-center rounded-xl ${tone}`}>
                  <Icon aria-hidden="true" className="size-5" />
                </span>
                <div className="min-w-0">
                  <MediumRowLabel as="p" className="!text-sm !leading-5">{title}</MediumRowLabel>
                  <RowDescription className="mt-0.5 !text-xs !leading-5">{detail}</RowDescription>
                </div>
              </li>
            ))}
          </ul>
        </div>
        <div className="flex flex-col items-center sm:col-span-2">
          <Button
            onClick={onConnect}
            disabled={busy}
            className="min-h-12 w-full max-w-sm justify-center gap-3 !text-sm"
            data-voice-control-id="open_gmail_connector"
            data-voice-action-id={connectActionId}
            data-voice-label={primaryActionLabel}
            data-voice-purpose="starts Mail connection from this workspace."
          >
            {primaryActionLabel}
          </Button>

        </div>
      </SurfaceInset>
    );
  }

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
            <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
              Gmail
            </p>
            <h2 className="text-lg font-semibold tracking-tight text-foreground">
              {oauthCompletionPending
                ? "Finishing Gmail connection"
                : "Checking your Gmail status"}
            </h2>
            <p className="text-sm text-muted-foreground">
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
              <p className="break-words text-sm text-muted-foreground">
                {statusSummary.detail}
              </p>
            ) : null}
            {statusSummary.helper ? (
              <p className="break-words text-xs text-muted-foreground">
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
        <p className="text-xs text-muted-foreground">
          Scanning Mail for receipts. Your list will refresh here when it
          finishes.
        </p>
      ) : null}
      {hasStaleBackgroundSync ? (
        <p className="text-xs text-amber-600">
          Mail is still running in the background. This status may lag behind for
          a bit.
        </p>
      ) : null}
      {!isConnected && !loadingStatus ? (
        <div className="flex flex-col items-center justify-center gap-2 pt-2 sm:flex-row">
          <Button
            onClick={onConnect}
            disabled={busy}
            className="h-12 w-full max-w-[244px] justify-center px-8 text-center text-base shadow-lg"
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
              className="h-12 w-full max-w-[244px] justify-center px-8 text-center text-base"
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
