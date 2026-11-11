import { useEffect, useState } from "react";
import type { Meeting, MeetingRequestOutcome } from "@/lib/services/calendar-insights-service";

// While an approved request is being shared and verified, check again soon and
// for a bounded time. The organizer's completion event is the fast path; this
// is the fallback for a missed or delayed event and for Google access that
// lags a completed share.
const ACCESS_RECHECK_MS = 6_000;
const ACCESS_RECHECK_LIMIT = 20;

/**
 * Sharing is under way, or Drive finished and this account's access has not
 * verified yet. Never Available until the requester's own account verifies it.
 * Returns true once the bounded checks for the current state are used up.
 */
export function useAccessWatch({ meetings, outcomes, active, revision, refresh }: {
  meetings: Meeting[]; outcomes: Record<string, MeetingRequestOutcome>;
  active: boolean; revision: number; refresh: () => void;
}): boolean {
  const watch = meetings.flatMap(meeting =>
    (outcomes[meeting.occurrence_id]?.requests || [])
      .filter(item => item.status === "approved" ||
        (!meeting.artifact_kinds.length && (item.status === "completed" || item.status === "partial")))
      .map(item => `${item.requestId}:${item.status}`)).join("|");
  // Counted per watched state, so a new request or a new phase gets its own bounded checks.
  const [checks, setChecks] = useState({ watch: "", count: 0 });
  const exhausted = (checks.watch === watch ? checks.count : 0) >= ACCESS_RECHECK_LIMIT;
  useEffect(() => {
    if (!watch || exhausted || !active) return;
    const timer = window.setTimeout(() => {
      setChecks(previous => ({ watch, count: previous.watch === watch ? previous.count + 1 : 1 }));
      refresh();
    }, ACCESS_RECHECK_MS);
    return () => window.clearTimeout(timer);
  }, [watch, exhausted, active, revision, refresh]);
  return exhausted;
}
