import type { ReactNode } from "react";
import { formatFeedTimestamp } from "@/lib/feed/feed-timestamp";

/** A clear title, then one secondary line when it adds useful context. */
export function FeedRowMetadata({
  title,
  source,
  description,
  descriptionId,
  indicator,
}: {
  title: ReactNode;
  source?: string;
  description?: ReactNode;
  descriptionId?: string;
  indicator?: ReactNode;
}) {
  return (
    <span data-slot="feed-inline-copy" className="flex min-w-0 items-start gap-1.5 whitespace-normal">
      {indicator}
      <span className="min-w-0 flex-1 break-words [overflow-wrap:anywhere]">
        {source ? <span data-slot="feed-source-label" className="mb-0.5 block text-xs font-medium text-[color:var(--app-secondary-label)]">{source}</span> : null}
        <span data-profile-role="name" className="block leading-snug">{title}</span>
        {description ? (
          <span
            id={descriptionId}
            data-slot="feed-event-description"
            data-profile-role="description"
            className="mt-0.5 block leading-snug text-[color:var(--app-secondary-label)]"
          >
            {description}
          </span>
        ) : null}
      </span>
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
  "[--settings-row-px:12px] [--settings-row-py:10px] [--settings-row-gap:8px] [&>button]:min-h-[64px] [&>a]:min-h-[64px] [&>div.grid]:min-h-[64px] group-data-[inset-separators=true]/settings-list:after:left-[50px]";
