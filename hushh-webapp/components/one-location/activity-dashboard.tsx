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
  "overflow-hidden rounded-[20px] border border-black/[0.05] bg-white shadow-[0_1px_2px_rgba(0,0,0,0.04),0_10px_30px_rgba(15,23,42,0.05)] dark:border-white/[0.08] dark:bg-[#1c1c1e]/90 dark:shadow-[0_12px_38px_rgba(0,0,0,0.28)]";

function activityRangeLabel(range: OneLocationActivityRange): string {
  return (
    ACTIVITY_RANGE_OPTIONS.find((option) => option.value === range)?.label ||
    "Selected range"
  );
}

function activityEventToneClassName(kind: OneLocationActivityKind): string {
  if (kind === "share") {
    return "bg-[#eaf9ef] text-[#2dbd5a] dark:bg-emerald-400/15 dark:text-emerald-200";
  }
  if (kind === "request") {
    return "bg-[#eaf3ff] text-[#007aff] dark:bg-[#0a84ff]/15 dark:text-[#76b7ff]";
  }
  return "bg-[#fff3e6] text-[#ff9500] dark:bg-orange-400/15 dark:text-orange-200";
}

function ActivitySectionLabel({ title }: { title: string }) {
  return (
    <div
      role="heading"
      aria-level={2}
      className="ml-1 flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-[0.08em] text-[#8e8e93] dark:text-white/45"
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
    <div className="rounded-[14px] border border-black/[0.04] bg-[#f7f7fa] p-3 dark:border-white/[0.08] dark:bg-white/[0.07]">
      <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[#8e8e93] dark:text-white/45">
        {label}
      </p>
      <p className="mt-1 text-[24px] font-bold leading-none text-[#1c1c1e] dark:text-white">
        {value}
      </p>
      <p className="mt-1 text-[11px] font-medium text-[#8e8e93] dark:text-white/55">
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
    <div className="flex flex-col items-center justify-center gap-2 rounded-[14px] border border-dashed border-black/[0.08] bg-[#f7f7fa] p-5 text-center dark:border-white/[0.12] dark:bg-white/[0.05]">
      <Icon className="h-5 w-5 text-[#8e8e93]" aria-hidden="true" />
      <p className="text-[14px] font-semibold text-[#1c1c1e] dark:text-white">
        {title}
      </p>
      <p className="max-w-[320px] text-[12px] leading-5 text-[#8e8e93] dark:text-white/55">
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
    <section className="space-y-2 px-1">
      <ActivitySectionLabel title="Location activity" />
      <div className={cn(activityPanelClassName, "space-y-4 p-3.5")}>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#eaf3ff] text-[#007aff] dark:bg-[#0a84ff]/15 dark:text-[#76b7ff]">
              {loading ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <BarChart3 className="h-4 w-4" aria-hidden="true" />
              )}
            </span>
            <div className="min-w-0">
              <h3 className="text-[15px] font-bold tracking-tight text-[#1c1c1e] dark:text-white">
                Activity history
              </h3>
              <p className="mt-1 text-[12px] leading-5 text-[#8e8e93] dark:text-white/55">
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
            <SelectTrigger className="h-9 w-full rounded-[12px] border-black/[0.04] bg-white text-[13px] shadow-sm sm:w-[132px] dark:border-white/[0.08] dark:bg-white/[0.07]">
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

        <div className="grid gap-2 sm:grid-cols-3">
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
            aria-label={`One Location activity chart for ${activityRangeLabel(
              range,
            )}`}
            className="rounded-[14px] border border-black/[0.04] bg-white/70 p-3 dark:border-white/[0.08] dark:bg-white/[0.04]"
          >
            <div className="flex h-32 items-end gap-2">
              {activity.buckets.map((bucket) => {
                const height = Math.max(12, (bucket.total / maxBucketTotal) * 100);
                return (
                  <div
                    key={bucket.key}
                    className="flex min-w-0 flex-1 flex-col items-center gap-1"
                  >
                    <div className="flex h-24 w-full items-end">
                      <div
                        className="flex w-full flex-col justify-end overflow-hidden rounded-t-[8px] bg-[#e5e5ea] dark:bg-white/10"
                        style={{ height: `${height}%` }}
                        title={`${bucket.label}: ${bucket.total} activities`}
                      >
                        {bucket.publicActivity > 0 ? (
                          <span
                            className="block bg-[#ff9500]"
                            style={{
                              flexGrow: bucket.publicActivity,
                              minHeight: 3,
                            }}
                          />
                        ) : null}
                        {bucket.requests > 0 ? (
                          <span
                            className="block bg-[#007aff]"
                            style={{ flexGrow: bucket.requests, minHeight: 3 }}
                          />
                        ) : null}
                        {bucket.shares > 0 ? (
                          <span
                            className="block bg-[#34c759]"
                            style={{ flexGrow: bucket.shares, minHeight: 3 }}
                          />
                        ) : null}
                      </div>
                    </div>
                    <span className="max-w-full truncate text-[10px] font-semibold text-[#8e8e93] dark:text-white/45">
                      {bucket.label}
                    </span>
                  </div>
                );
              })}
            </div>
            <div className="mt-3 flex flex-wrap gap-2 text-[11px] font-semibold text-[#8e8e93] dark:text-white/50">
              <span className="inline-flex items-center gap-1">
                <span className="h-2 w-2 rounded-full bg-[#34c759]" />
                Shares
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="h-2 w-2 rounded-full bg-[#007aff]" />
                Requests
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="h-2 w-2 rounded-full bg-[#ff9500]" />
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
            <p className="ml-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-[#8e8e93] dark:text-white/45">
              Recent history
            </p>
            <div className="space-y-2">
              {recentEvents.map((event) => (
                <div
                  key={event.id}
                  className="flex items-start gap-3 rounded-[14px] bg-[#f7f7fa] p-3 dark:bg-white/[0.07]"
                >
                  <span
                    className={cn(
                      "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full",
                      activityEventToneClassName(event.kind),
                    )}
                  >
                    <Clock3 className="h-4 w-4" aria-hidden="true" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[14px] font-semibold text-[#1c1c1e] dark:text-white">
                      {event.title}
                    </p>
                    <p className="mt-0.5 truncate text-[12px] font-medium text-[#8e8e93] dark:text-white/55">
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
