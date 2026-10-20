"use client";

import { ChevronDown } from "@/components/icons";
import { ConnectionPersonAvatar } from "@/components/connections/connection-person-avatar";
import { FeedActionableRow } from "@/components/feed/feed-actionable-row";
import { FeedSmsSentTime } from "@/components/feed/feed-sms-sent-time";
import type { FeedSmsAlertGroup as SmsGroup } from "@/lib/feed/feed-sms-grouping";

/** Inline disclosure keeps repeated incidents available without flooding Feed. */
export function FeedSmsAlertGroup({ group }: { group: SmsGroup }) {
  if (group.items.length === 1) return <FeedActionableRow item={group.latest} />;
  const { latest, activeCount } = group;
  const label = latest.person?.displayName ?? latest.title;
  return (
    <details className="group/sms" data-testid="feed-sms-alert-group">
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-3 px-3 py-3 focus-visible:outline-2 focus-visible:outline-accent [&::-webkit-details-marker]:hidden">
        <ConnectionPersonAvatar label={label} photoUrl={latest.person?.photoUrl} size="compact" />
        <span className="min-w-0 flex-1 space-y-0.5">
          <span data-profile-role="name" className="block truncate">{label}</span>
          <span data-profile-role="description" className="block text-muted-foreground">
            {group.items.length} recent SMS alerts · {activeCount > 0 ? `${activeCount} active` : "All ended"}
          </span>
          <FeedSmsSentTime timestamp={latest.displayTimestamp} label={activeCount > 0 ? "Latest active alert sent" : "Latest sent"} />
        </span>
        <ChevronDown aria-hidden="true" className="size-4 shrink-0 text-muted-foreground group-open/sms:rotate-180" />
      </summary>
      <div className="divide-y divide-[color:var(--foundation-hairline)] border-t border-[color:var(--foundation-hairline)]">
        {group.items.map((item) => <FeedActionableRow key={item.id} item={item} />)}
      </div>
    </details>
  );
}
