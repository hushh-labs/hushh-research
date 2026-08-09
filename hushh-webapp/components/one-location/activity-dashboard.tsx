import type { LucideIcon } from "lucide-react";
import { BarChart3, CalendarDays, Clock3, Loader2 } from "lucide-react";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type {
  OneLocationActivityKind,
  OneLocationActivityRange,
  OneLocationActivityResponse,
} from "@/lib/one-location/types";
import { cn } from "@/lib/utils";
import {
  CARD_SURFACE,
  SUBCARD_SURFACE,
} from "@/components/one-location/redesign/tokens";

const ACTIVITY_RANGE_OPTIONS: {
  value: OneLocationActivityRange;
  label: string;
}[] = [
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "90d", label: "90 days" },
  { value: "all", label: "All time" },
];

const activityPanelClassName =
  cn("w-full min-w-0 max-w-full overflow-hidden", CARD_SURFACE);

function activityRangeLabel(range: OneLocationActivityRange): string {
  return (
    ACTIVITY_RANGE_OPTIONS.find((option) => option.value === range)?.label ||
    "Selected range"
  );
}

function activityEventToneClassName(kind: OneLocationActivityKind): string {
  if (kind === "share") {
    return "bg-[color:var(--app-success)]/12 text-[color:var(--app-success)] dark:bg-[color:var(--app-success)]/15";
  }
  if (kind === "request") {
    return "bg-[color:var(--app-accent)]/12 text-[color:var(--app-accent)] dark:bg-[color:var(--app-accent)]/15";
  }
  return "bg-[color:var(--app-warning)]/12 text-[color:var(--app-warning)] dark:bg-[color:var(--app-warning)]/15";
}

function ActivitySectionLabel({ title }: { title: string }) {
  return (
    <div
      role="heading"
      aria-level={2}
      className="ml-1 flex min-w-0 max-w-full flex-wrap items-center gap-1.5 text-[13px] font-normal leading-[18px] tracking-normal text-muted-foreground"
    >
      {title}
    </div>
  );
}

function ActivityMetricTile({
  label,
  value,
  detail,
}: {
  label: string;
  value: number;
  detail: string;
}) {
  return (
    <div className={cn("min-w-0 p-3.5", SUBCARD_SURFACE)}>
      <p className="text-[12px] font-normal leading-4 tracking-normal text-muted-foreground">
        {label}
      </p>
      <p className="mt-1 text-[24px] font-semibold leading-none text-foreground">
        {value}
      </p>
      <p className="mt-1 break-words text-[12px] leading-4 text-muted-foreground [overflow-wrap:anywhere]">
        {detail}
      </p>
    </div>
  );
}

function EmptyActivityState({
  icon: Icon,
  title,
  description,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-2 border-dashed p-5 text-center", SUBCARD_SURFACE)}>
      <Icon className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
      <p className="text-[15px] font-semibold leading-5 text-foreground">
        {title}
      </p>
      <p className="max-w-[320px] text-[13px] leading-[18px] text-muted-foreground">
        {description}
      </p>
    </div>
  );
}

export function OneLocationActivityDashboard({
  activity,
  range,
  loading,
  error,
  onRangeChange,
}: {
  activity: OneLocationActivityResponse;
  range: OneLocationActivityRange;
  loading: boolean;
  error: string | null;
  onRangeChange: (value: OneLocationActivityRange) => void;
}) {
  const maxBucketTotal = Math.max(
    1,
    ...activity.buckets.map((bucket) => bucket.total),
  );
  const recentEvents = activity.events.slice(0, 5);

  return (
    <section className="min-w-0 max-w-full space-y-2 px-1">
      <ActivitySectionLabel title="Location activity" />
      <div className={cn(activityPanelClassName, "space-y-4 p-4")}>
        <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <span className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[10px] bg-[color:var(--app-accent)]/12 text-[color:var(--app-accent)] dark:bg-[color:var(--app-accent)]/15">
              {loading ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <BarChart3 className="h-4 w-4" aria-hidden="true" />
              )}
            </span>
            <div className="min-w-0">
              <h3 className="text-[17px] font-semibold leading-[22px] tracking-normal text-foreground">
                Activity history
              </h3>
              <p className="mt-1 break-words text-[15px] leading-5 text-muted-foreground [overflow-wrap:anywhere]">
                {error ||
                  `${activityRangeLabel(range)} of shares, requests, views, and link responses.`}
              </p>
            </div>
          </div>
          <Select
            value={range}
            onValueChange={(value) =>
              onRangeChange(value as OneLocationActivityRange)
            }
          >
            <SelectTrigger className="h-9 w-full rounded-[12px] border-border/60 bg-[color:var(--app-card-surface-compact)] text-[13px] shadow-none sm:w-[132px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ACTIVITY_RANGE_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="grid min-w-0 gap-2 sm:grid-cols-3">
          <ActivityMetricTile
            label="Shared with"
            value={activity.summary.sharedWithCount}
            detail={`${activity.summary.activeShareCount} active now`}
          />
          <ActivityMetricTile
            label="Requests"
            value={
              activity.summary.requestsReceivedCount +
              activity.summary.requestsSentCount
            }
            detail={`${activity.summary.requestsReceivedCount} in / ${activity.summary.requestsSentCount} out`}
          />
          <ActivityMetricTile
            label="Views"
            value={activity.summary.viewsCount}
            detail={`${activity.summary.publicResponseCount} public responses`}
          />
        </div>

        {activity.buckets.length ? (
          <div
            aria-label={`Location activity chart for ${activityRangeLabel(
              range,
            )}`}
            className={cn("min-w-0 max-w-full overflow-hidden p-3", SUBCARD_SURFACE)}
          >
            <div className="flex h-32 min-w-0 items-end gap-1.5 sm:gap-2">
              {activity.buckets.map((bucket) => {
                const height = Math.max(12, (bucket.total / maxBucketTotal) * 100);
                return (
                  <div
                    key={bucket.key}
                    className="flex min-w-0 flex-1 basis-0 flex-col items-center gap-1"
                  >
                    <div className="flex h-24 w-full items-end">
                      <div
                        className="flex w-full flex-col justify-end overflow-hidden rounded-t-[8px] bg-[color:var(--app-neutral-fill-strong)] dark:bg-white/10"
                        style={{ height: `${height}%` }}
                        title={`${bucket.label}: ${bucket.total} activities`}
                      >
                        {bucket.publicActivity > 0 ? (
                          <span
                            className="block bg-[color:var(--app-warning)]"
                            style={{
                              flexGrow: bucket.publicActivity,
                              minHeight: 3,
                            }}
                          />
                        ) : null}
                        {bucket.requests > 0 ? (
                          <span
                            className="block bg-[color:var(--app-accent)]"
                            style={{ flexGrow: bucket.requests, minHeight: 3 }}
                          />
                        ) : null}
                        {bucket.shares > 0 ? (
                          <span
                            className="block bg-[color:var(--app-success)]"
                            style={{ flexGrow: bucket.shares, minHeight: 3 }}
                          />
                        ) : null}
                      </div>
                    </div>
                    <span className="max-w-full truncate text-[11px] font-normal leading-4 text-muted-foreground">
                      {bucket.label}
                    </span>
                  </div>
                );
              })}
            </div>
            <div className="mt-3 flex flex-wrap gap-2 text-[12px] font-normal leading-4 text-muted-foreground">
              <span className="inline-flex items-center gap-1">
                <span className="h-2 w-2 rounded-full bg-[color:var(--app-success)]" />
                Shares
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="h-2 w-2 rounded-full bg-[color:var(--app-accent)]" />
                Requests
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="h-2 w-2 rounded-full bg-[color:var(--app-warning)]" />
                Links
              </span>
            </div>
          </div>
        ) : (
          <EmptyActivityState
            icon={CalendarDays}
            title="No activity in this range"
            description="Shares, requests, views, and request-link responses will appear here."
          />
        )}

        {recentEvents.length ? (
          <div className="space-y-2">
            <p className="ml-1 text-[13px] font-normal leading-[18px] tracking-normal text-muted-foreground">
              Recent history
            </p>
            <div className="min-w-0 space-y-2">
              {recentEvents.map((event) => (
                <div
                  key={event.id}
                  className={cn("flex min-w-0 items-start gap-3 overflow-hidden p-3", SUBCARD_SURFACE)}
                >
                  <span
                    className={cn(
                      "mt-0.5 flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[10px]",
                      activityEventToneClassName(event.kind),
                    )}
                  >
                    <Clock3 className="h-4 w-4" aria-hidden="true" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="break-words text-[15px] font-semibold leading-5 text-foreground [overflow-wrap:anywhere]">
                      {event.title}
                    </p>
                    <p className="mt-0.5 break-words text-[13px] leading-[18px] text-muted-foreground [overflow-wrap:anywhere]">
                      {event.detail}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}
