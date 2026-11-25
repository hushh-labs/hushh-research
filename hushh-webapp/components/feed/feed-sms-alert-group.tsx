"use client";

import { FeedActionableRow } from "@/components/feed/feed-actionable-row";
import type { FeedSmsAlertGroup as SmsGroup } from "@/lib/feed/feed-sms-grouping";

/** Compatibility presentation for one verified incident, never a sender group. */
export function FeedSmsAlertGroup({ group }: { group: SmsGroup }) {
  return <FeedActionableRow item={group.latest} />;
}
