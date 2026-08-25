"use client";

import { ChevronDown, CircleAlert, Loader2, MailCheck } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { EmailDraft } from "@/lib/services/email-delivery-service";

export type EmailDeliveryHistoryItem = {
  id: string;
  instruction: string;
  draft: EmailDraft;
  status: "sending" | "sent" | "failed" | "outcome_unknown";
  errorMessage?: string | null;
};

type EmailDeliveryHistoryCardProps = {
  item: EmailDeliveryHistoryItem;
  onRetry?: (item: EmailDeliveryHistoryItem) => void;
};

function statusCopy(item: EmailDeliveryHistoryItem): string {
  switch (item.status) {
    case "sending":
      return "Sending in the background…";
    case "sent":
      return "Email sent";
    case "outcome_unknown":
      return "Delivery status needs checking";
    default:
      return item.errorMessage || "Email could not be sent.";
  }
}

/**
 * A live-chat receipt for the owner-reviewed draft. It deliberately stays in
 * React memory: raw mail fields must not be copied into durable chat history
 * or general workflow records.
 */
export function EmailDeliveryHistoryCard({
  item,
  onRetry,
}: EmailDeliveryHistoryCardProps) {
  const canRetry = item.status === "failed";

  return (
    <details
      className="group mb-4 overflow-hidden rounded-[var(--app-card-radius-compact)] border border-border/70 bg-muted/35"
      data-testid={`one-email-history-${item.status}`}
    >
      <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3 marker:hidden [&::-webkit-details-marker]:hidden">
        <span
          className={
            item.status === "failed" || item.status === "outcome_unknown"
              ? "grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-destructive/10 text-destructive"
              : "grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary"
          }
        >
          {item.status === "sending" ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          ) : item.status === "failed" || item.status === "outcome_unknown" ? (
            <CircleAlert className="h-4 w-4" aria-hidden />
          ) : (
            <MailCheck className="h-4 w-4" aria-hidden />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold text-foreground">
            {item.status === "sending" ? "Email sending" : "Email activity"}
          </span>
          <span className="block truncate text-sm text-muted-foreground">
            {statusCopy(item)}
          </span>
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200 group-open:rotate-180" aria-hidden />
      </summary>

      <div className="space-y-3 border-t border-border/60 px-4 py-4 text-sm">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            Your request
          </p>
          <p className="mt-1 whitespace-pre-wrap break-words text-foreground">
            {item.instruction}
          </p>
        </div>
        <dl className="grid gap-3 sm:grid-cols-2">
          <div>
            <dt className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">To</dt>
            <dd className="mt-1 break-words text-foreground">{item.draft.to || "—"}</dd>
          </div>
          <div>
            <dt className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">Subject</dt>
            <dd className="mt-1 break-words text-foreground">{item.draft.subject || "—"}</dd>
          </div>
          {item.draft.cc ? (
            <div>
              <dt className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">Cc</dt>
              <dd className="mt-1 break-words text-foreground">{item.draft.cc}</dd>
            </div>
          ) : null}
          {item.draft.bcc ? (
            <div>
              <dt className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">Bcc</dt>
              <dd className="mt-1 break-words text-foreground">{item.draft.bcc}</dd>
            </div>
          ) : null}
        </dl>
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            Message
          </p>
          <p className="mt-1 whitespace-pre-wrap break-words text-foreground">{item.draft.body || "—"}</p>
        </div>
        {canRetry && onRetry ? (
          <Button type="button" variant="outline" size="sm" onClick={() => onRetry(item)}>
            Edit and retry
          </Button>
        ) : null}
      </div>
    </details>
  );
}
