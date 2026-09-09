import type { ReactNode } from "react";
import { formatFeedTimestamp } from "@/lib/feed/feed-timestamp";

/** Keep event copy readable without allowing a timestamp to compete for width. */
export function FeedRowMetadata({
  description,
  timestamp,
}: {
  description: ReactNode;
  timestamp?: string | number | null;
}) {
  const label = timestamp != null ? formatFeedTimestamp(timestamp) : null;
  return (
    <span className="block space-y-0.5">
      {description ? (
        <span
          data-slot="feed-event-description"
          className="block whitespace-normal [overflow-wrap:anywhere]"
        >
          {description}
        </span>
      ) : null}
      {label ? (
        <time
          data-slot="feed-event-time"
          dateTime={new Date(timestamp!).toISOString()}
          className="block text-xs tabular-nums text-muted-foreground"
        >
          {label}
        </time>
      ) : null}
    </span>
  );
}
