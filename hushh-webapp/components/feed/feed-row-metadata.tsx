import type { ReactNode } from "react";
import { formatFeedTimestamp } from "@/lib/feed/feed-timestamp";

/** One text track; the complete description remains in the accessible row copy. */
export function FeedRowMetadata({
  title,
  description,
  descriptionId,
  indicator,
}: {
  title: ReactNode;
  description?: ReactNode;
  descriptionId?: string;
  indicator?: ReactNode;
}) {
  return (
    <span data-slot="feed-inline-copy" className="flex min-w-0 items-center gap-1.5 whitespace-nowrap">
      {indicator}
      <span data-profile-role="name" className="min-w-0 truncate">{title}</span>
      {description ? (
        <span
          id={descriptionId}
          data-slot="feed-event-description"
          data-profile-role="description"
          className="min-w-0 flex-1 truncate text-[color:var(--app-secondary-label)]"
        >
          {description}
        </span>
      ) : null}
    </span>
  );
}

export function FeedRowTimestamp({ timestamp }: { timestamp?: string | number | null }) {
  const label = timestamp != null ? formatFeedTimestamp(timestamp) : null;
  if (!label || timestamp == null) return null;
  return (
    <time
      data-slot="feed-event-time"
      data-profile-role="description"
      dateTime={new Date(timestamp).toISOString()}
      className="shrink-0 whitespace-nowrap tabular-nums text-[color:var(--app-secondary-label)]"
    >
      {label}
    </time>
  );
}

export const FEED_INLINE_ROW_CLASSNAME =
  "[--settings-row-px:12px] [--settings-row-py:6px] [--settings-row-gap:8px] [&>button]:min-h-[52px] [&>a]:min-h-[52px] [&>div.grid]:min-h-[52px] [&>button]:grid-cols-[minmax(0,1fr)_auto] [&>a]:grid-cols-[minmax(0,1fr)_auto] [&>div.grid]:grid-cols-[minmax(0,1fr)_auto] group-data-[inset-separators=true]/settings-list:after:left-[50px]";
