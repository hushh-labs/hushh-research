"use client";

import { FeedActionableRow } from "@/components/feed/feed-actionable-row";
import type { FeedSmsAlertGroup as SmsGroup } from "@/lib/feed/feed-sms-grouping";

/** Repeated alerts replace the row; superseded incidents are not Feed history. */
export function FeedSmsAlertGroup({ group }: { group: SmsGroup }) {
  return <FeedActionableRow item={group.latest} />;
}
