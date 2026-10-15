"use client";

import {
  toCountBucket,
  toMinuteDurationBucket,
  trackEvent,
} from "@/lib/observability/client";
import type {
  EventPayloadFor,
  LiveMemorySourceKind,
  LiveMemorySourceOutcome,
} from "@/lib/observability/events";

/**
 * What one living source check looked like from inside a sync build. Exact
 * numbers stay here; only their buckets leave this module.
 */
export interface LiveMemorySourceCheck {
  kind: LiveMemorySourceKind;
  outcome: LiveMemorySourceOutcome;
  /** Commit-to-encrypted-write lag of the oldest change this check cleared; null when unmeasured. */
  lagMs: number | null;
  /** Committed changes waiting on this source; null when the journal could not count them. */
  pendingCount: number | null;
  /** Failed reads in a row before this one; null when the source keeps no retry state. */
  retryCount: number | null;
}

/** How the build that made the checks ended. */
export interface LiveMemorySourceBuild {
  /** Whether the encrypted write changed anything. */
  stored: boolean;
}

export type LiveMemorySourceVerifiedEvent = EventPayloadFor<"live_memory_source_verified">;

/**
 * Turns the checks a build made into the events it may emit: one per kind,
 * first check wins, every number replaced by its band.
 *
 * The profile is read on every wake, so it is reported only when the build
 * wrote a change. Every other kind is checked only when it is read, so a quiet
 * wake that reused its sources plans nothing.
 *
 * This is the privacy boundary for Live Memory telemetry. The payload has
 * exactly five keys, none of which can carry an owner, a record, a value or a
 * time. Anything else on the check is dropped here, before `trackEvent` sees it.
 */
export function planLiveMemorySourceTelemetry(
  checks: readonly LiveMemorySourceCheck[],
  build: LiveMemorySourceBuild,
): LiveMemorySourceVerifiedEvent[] {
  const events = new Map<LiveMemorySourceKind, LiveMemorySourceVerifiedEvent>();
  for (const check of checks) {
    if (events.has(check.kind)) continue;
    if (check.kind === "profile" && !build.stored) continue;
    events.set(check.kind, {
      kind: check.kind,
      outcome: check.outcome,
      lag_bucket: toMinuteDurationBucket(check.lagMs),
      pending_bucket: toCountBucket(check.pendingCount),
      retry_bucket: toCountBucket(check.retryCount),
    });
  }
  return [...events.values()];
}

/**
 * Emits the build's source checks after a successful encrypted store.
 * Telemetry is a bystander: it can never fail, delay or alter the sync.
 */
export function emitLiveMemorySourceTelemetry(
  checks: readonly LiveMemorySourceCheck[],
  build: LiveMemorySourceBuild,
): void {
  try {
    for (const event of planLiveMemorySourceTelemetry(checks, build)) {
      trackEvent("live_memory_source_verified", event);
    }
  } catch {
    // A telemetry sink failure is not a sync failure.
  }
}
