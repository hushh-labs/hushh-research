"use client";
import { MailCheck } from "@/components/icons";
import { MailActionButton as Button } from "./mail-action-button";
import { Button as MorphyButton } from "@/lib/morphy-ux/button";
import { openExternalUrl } from "@/lib/utils/browser-navigation";
import type { GmailInformationRequestWorkflow } from "@/lib/services/gmail-information-requests-service";
import mailStyles from "./mail-workspace.module.css";

export function gmailThreadUrl(threadId: string): string {
  return `https://mail.google.com/mail/#all/${encodeURIComponent(threadId)}`;
}

export function fieldLabels(workflow: GmailInformationRequestWorkflow): string {
  return (
    workflow.requested_field_labels
      .slice(0, 3)
      .map((label) => {
        const readable = label
          .replace(/[_-]+/g, " ")
          .replace(/\s+/g, " ")
          .trim();
        return readable
          ? `${readable.charAt(0).toUpperCase()}${readable.slice(1)}`
          : "";
      })
      .filter(Boolean)
      .join(", ") ||
    "Personal information"
  );
}

export function WorkflowQueueCard({
  workflow,
  onReview,
  onDraftWithOne,
}: {
  workflow: GmailInformationRequestWorkflow;
  onReview: () => void;
  onDraftWithOne: () => void;
}) {
  return (
    <div className="consent-presentation-surface rounded-[var(--app-card-radius-md)] border border-[color:var(--app-card-border-standard)] bg-background/60 px-4 py-4 transition-colors hover:border-primary/25 hover:bg-primary/[0.025]">
      <div className="flex min-w-0 flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-full border border-primary/20 bg-primary/10 text-primary">
            <MailCheck className="h-[18px] w-[18px]" aria-hidden="true" />
          </div>
          <div className="min-w-0 space-y-1">
            <p data-consent-role="row-title" className={`${mailStyles.rowName} text-foreground`}>
              Information requested
            </p>
            <p data-consent-role="helper" className="line-clamp-2 text-xs leading-5 text-muted-foreground sm:truncate sm:leading-normal">
              {fieldLabels(workflow)}
            </p>
            <p data-consent-role="helper" className="text-xs text-muted-foreground">
              {workflow.received_at
                ? `Received ${new Intl.DateTimeFormat(undefined, {
                    dateStyle: "medium",
                  }).format(new Date(workflow.received_at))}`
                : "New request"}
              {workflow.attachment_review_required
                ? " · Attachment included"
                : ""}
            </p>
          </div>
        </div>
        <div className="grid w-full grid-cols-2 gap-2 sm:w-[19.5rem] sm:shrink-0 sm:grid-cols-[minmax(0,1fr)_8.25rem]">
          <Button
            type="button"
            size="sm"
            className="min-h-11 min-w-0 justify-center"
            onClick={onDraftWithOne}
          >
            Draft with One
          </Button>
          <Button
            type="button"
            variant="muted"
            size="sm"
            className="min-h-11 min-w-0 justify-center"
            data-consent-quiet-action="true"
            onClick={onReview}
          >
            Review
          </Button>
        </div>
      </div>
    </div>
  );
}

export function ActivityCard({
  workflow, showTimestamp = true,
}: {
  workflow: GmailInformationRequestWorkflow;
  showTimestamp?: boolean;
}) {
  const label =
    workflow.status === "sent"
      ? "Reply sent"
      : workflow.status === "ignored"
        ? "Request ignored"
        : workflow.status === "blocked"
          ? "Request blocked"
          : "Needs attention";
  const timestamp =
    workflow.updated_at || workflow.received_at || workflow.created_at;

  return (
    <div className="consent-presentation-surface flex items-start justify-between gap-3 rounded-xl border border-[color:var(--app-card-border-standard)] bg-background/60 px-3.5 py-3">
      <div className="min-w-0 space-y-1">
        <p data-consent-role="row-title" className={`${mailStyles.rowName} text-foreground`}>{label}</p>
        <p data-consent-role="helper" className="truncate text-xs text-muted-foreground">
          {fieldLabels(workflow)}
        </p>
        {showTimestamp && timestamp ? (
          <p data-consent-role="helper" className="text-xs text-muted-foreground">
            {new Intl.DateTimeFormat(undefined, {
              dateStyle: "medium",
              timeStyle: "short",
            }).format(new Date(timestamp))}
          </p>
        ) : null}
      </div>
      {workflow.gmail_thread_id ? (
        <MorphyButton
          type="button"
          variant="none"
          effect="fade"
          size="compact"
          className={`${mailStyles.utilityAction} shrink-0`}
          onClick={() => openExternalUrl(gmailThreadUrl(workflow.gmail_thread_id!))}
        >
          Open Mail
        </MorphyButton>
      ) : null}
    </div>
  );
}

