import type { CountBucket } from "@/lib/observability/events";

/** How a live activity consolidation cycle ended once it reached a decision. */
export const LIVE_ACTIVITY_CONSOLIDATION_OUTCOMES = ["saved", "nothing_durable", "host_skipped", "failed", "memory_full"] as const;
export type LiveActivityConsolidationTelemetryOutcome = (typeof LIVE_ACTIVITY_CONSOLIDATION_OUTCOMES)[number];

/** A device activity consolidation reached a decision. Closed sets only: no owner, statement, fact or time. */
export type LiveActivityConsolidationPayload = {
  outcome: LiveActivityConsolidationTelemetryOutcome;
  saved_bucket: CountBucket;
};
