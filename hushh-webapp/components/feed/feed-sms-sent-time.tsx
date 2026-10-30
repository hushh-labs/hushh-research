import { formatLocalDateTime } from "@/lib/utils/local-date-time";

/** SMS groups span days; show the actual sent instant, including on phones. */
export function FeedSmsSentTime({ timestamp, label = "Sent" }: { timestamp?: number | null; label?: string }) {
  const formatted = formatLocalDateTime(timestamp, {
    year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
  return (
    <span data-profile-role="description" className="block whitespace-normal text-muted-foreground">
      {formatted && timestamp != null ? (
        <>{label} <time data-slot="feed-event-time" dateTime={new Date(timestamp).toISOString()} className="tabular-nums">{formatted}</time></>
      ) : "Sent time unavailable"}
    </span>
  );
}
