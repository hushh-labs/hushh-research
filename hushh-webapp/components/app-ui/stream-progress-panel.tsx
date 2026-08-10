"use client";

import { memo, type ReactNode } from "react";
import {
  Activity,
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  Loader2,
  type LucideIcon,
} from "lucide-react";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Progress } from "@/components/ui/progress";
import { StreamingCursor } from "@/lib/morphy-ux/streaming-cursor";
import { cn } from "@/lib/utils";

export type AppStreamProgressStatus = "running" | "done" | "blocked" | "error";

export type AppStreamProgressItem = {
  id: string;
  label?: string;
  message: string;
  status?: AppStreamProgressStatus;
  badge?: string;
};

type AppStreamEventListProps = {
  items: AppStreamProgressItem[];
  emptyLabel?: string;
  ariaLabel: string;
  className?: string;
};

function ProgressStatusIcon({ status }: { status: AppStreamProgressStatus }) {
  if (status === "done") return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />;
  if (status === "blocked" || status === "error") {
    return <AlertCircle className="h-3.5 w-3.5 text-destructive" />;
  }
  return <Loader2 className="h-3.5 w-3.5 animate-spin text-accent-strong" />;
}

export const AppStreamEventList = memo(function AppStreamEventList({
  items,
  emptyLabel,
  ariaLabel,
  className,
}: AppStreamEventListProps) {
  if (items.length === 0) {
    return emptyLabel ? (
      <div className={cn("ui-text-caption px-2.5 py-2", className)}>
        {emptyLabel}
      </div>
    ) : null;
  }

  return (
    <ol
      className={cn(
        "max-h-44 min-h-0 space-y-2 overflow-y-auto overscroll-contain pr-1",
        className
      )}
      aria-label={ariaLabel}
    >
      {items.map((item) => {
        const status = item.status ?? "running";
        return (
          <li key={item.id} className="ui-text-caption flex gap-2">
            {item.badge ? (
              <span className="mt-0.5 shrink-0 rounded border border-border/50 px-1.5 py-0.5 font-medium text-muted-foreground">
                {item.badge}
              </span>
            ) : (
              <span className="mt-0.5 shrink-0" aria-hidden="true">
                <ProgressStatusIcon status={status} />
              </span>
            )}
            <div className="min-w-0">
              {item.label ? <p className="font-medium text-foreground">{item.label}</p> : null}
              <p className="break-words text-muted-foreground">{item.message}</p>
            </div>
          </li>
        );
      })}
    </ol>
  );
});

export type AppStreamSectionProps = {
  title: string;
  items: AppStreamProgressItem[];
  content?: ReactNode;
  icon?: LucideIcon;
  count?: number;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  emptyLabel?: string;
  className?: string;
  bodyClassName?: string;
};

export function AppStreamSection({
  title,
  items,
  icon: Icon = Activity,
  count,
  defaultOpen = true,
  open,
  onOpenChange,
  emptyLabel,
  className,
  bodyClassName,
  content,
}: AppStreamSectionProps) {
  return (
    <Collapsible open={open} defaultOpen={defaultOpen} onOpenChange={onOpenChange}>
      <div className={cn("rounded-xl border border-border/60 bg-muted/20", className)}>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="ui-text-section-label group flex w-full items-center justify-between gap-3 px-[6px] py-2 text-left transition hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
          >
            <span className="inline-flex min-w-0 items-center gap-2">
              <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span className="truncate">{title}</span>
            </span>
            <span className="inline-flex shrink-0 items-center gap-2">
              {typeof count === "number" ? (
                <span className="rounded-full bg-accent-surface px-2 py-0.5 text-[12px] font-semibold leading-4 text-accent-strong">
                  {count}
                </span>
              ) : null}
              <ChevronDown
                className="h-3.5 w-3.5 transition-transform group-data-[state=open]:rotate-180"
                aria-hidden="true"
              />
            </span>
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className={cn("border-t border-border/50 px-3 py-2", bodyClassName)}>
            {content ?? (
              <AppStreamEventList
                items={items}
                emptyLabel={emptyLabel}
                ariaLabel={`${title} events`}
              />
            )}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

export type AppStreamPanelProps = {
  title?: string;
  progressValue?: number | null;
  progressIndeterminate?: boolean;
  statusMessage?: string;
  progressItems?: AppStreamProgressItem[];
  thinkingItems?: AppStreamProgressItem[];
  thinkingContent?: ReactNode;
  thinkingTitle?: string;
  evidenceItems?: AppStreamProgressItem[];
  evidenceTitle?: string;
  response?: ReactNode;
  responseText?: string;
  /** App-owned state shown while the model has not emitted response text yet. */
  responsePendingLabel?: string;
  isStreaming?: boolean;
  isError?: boolean;
  opportunities?: ReactNode;
  className?: string;
};

export function AppStreamPanel({
  title = "Response stream",
  progressValue = null,
  progressIndeterminate = false,
  statusMessage,
  progressItems = [],
  thinkingItems = [],
  thinkingContent,
  thinkingTitle = "Working notes",
  evidenceItems = [],
  evidenceTitle = "Consulted specialists",
  response,
  responseText = "",
  responsePendingLabel,
  isStreaming = false,
  isError = false,
  opportunities,
  className,
}: AppStreamPanelProps) {
  const hasResponseText = responseText.trim().length > 0;
  const hasResponse = Boolean(response) || hasResponseText;
  const showResponsePending = Boolean(
    responsePendingLabel && isStreaming && !hasResponse && !isError,
  );
  const showProgressMeter =
    progressIndeterminate || (typeof progressValue === "number" && Number.isFinite(progressValue));

  return (
    <section
      className={cn(
        "w-full max-w-none rounded-2xl border border-black/10 bg-white/70 p-3 shadow-sm shadow-black/[0.025] backdrop-blur-xl",
        "dark:border-white/10 dark:bg-white/[0.035] dark:shadow-none",
        className
      )}
      aria-label={title}
    >
      <div className="space-y-4">
        {opportunities ? <div>{opportunities}</div> : null}

        {showProgressMeter || statusMessage || progressItems.length > 0 ? (
          <div className="space-y-2">
            {showProgressMeter ? (
              typeof progressValue === "number" && Number.isFinite(progressValue) ? (
                <Progress value={Math.max(0, Math.min(100, progressValue))} className="h-2" />
              ) : (
                <div className="h-2 overflow-hidden rounded-full bg-secondary">
                  <div className="h-full w-1/3 animate-pulse rounded-full bg-primary/70" />
                </div>
              )
            ) : null}
            {statusMessage ? (
              <p className="text-xs text-muted-foreground">{statusMessage}</p>
            ) : null}
            {progressItems.length > 0 ? (
              <AppStreamSection
                title="Progress"
                items={progressItems}
                count={progressItems.length}
                defaultOpen
              />
            ) : null}
          </div>
        ) : null}

        {thinkingItems.length > 0 || thinkingContent ? (
          <AppStreamSection
            // Auto-open while reasoning streams and no answer has begun; remount
            // collapsed once the answer arrives so it never covers the response.
            key={hasResponse ? "thinking-collapsed" : "thinking-open"}
            title={thinkingTitle}
            items={thinkingItems}
            count={thinkingContent ? undefined : thinkingItems.length}
            defaultOpen={isStreaming && !hasResponse}
            bodyClassName={thinkingContent ? "px-3 py-2.5" : undefined}
            content={thinkingContent}
          />
        ) : null}

        {evidenceItems.length > 0 ? (
          <AppStreamSection
            title={evidenceTitle}
            items={evidenceItems}
            count={evidenceItems.length}
            defaultOpen={false}
            bodyClassName="px-3 py-2.5"
          />
        ) : null}

        {showResponsePending ? (
          <div
            role="status"
            aria-live="polite"
            className="inline-flex items-center gap-2 rounded-xl border border-border/60 bg-background/55 px-3 py-2 text-sm text-muted-foreground"
          >
            <Loader2 className="h-4 w-4 animate-spin text-accent-strong motion-reduce:animate-none" aria-hidden="true" />
            <span>{responsePendingLabel}</span>
          </div>
        ) : null}

        {hasResponse ? (
          <div
            className={cn(
              "rounded-xl border border-border/60 bg-background/70 px-3 py-3 text-sm leading-6",
              isError && "border-destructive/30 bg-destructive/10 text-destructive"
            )}
            aria-live={isStreaming ? "polite" : undefined}
          >
            {response ?? <p className="whitespace-pre-wrap break-words">{responseText}</p>}
            {isStreaming ? (
              <StreamingCursor
                isStreaming
                color={isError ? "error" : "primary"}
                size="md"
                className="ml-1"
              />
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}
