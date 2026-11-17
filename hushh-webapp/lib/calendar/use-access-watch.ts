import { useEffect, useState } from "react";
import type { Meeting, MeetingRequestOutcome } from "@/lib/services/calendar-insights-service";

// While an approved request is being shared and verified, check again soon and
// for a bounded time. The organizer's completion event is the fast path; this
// is the fallback for a missed or delayed event and for Google access that
// lags a completed share.
const ACCESS_RECHECK_MS = 6_000;
const ACCESS_RECHECK_LIMIT = 20;
// A request still waiting on the organizer changes less often, so it is checked
// more slowly (about five minutes in all) before the Feed event or focus takes over.
const WAITING_RECHECK_MS = 15_000;
const WAITING_STATUSES = ["pending", "preparing", "review_ready"];

/**
 * Sharing is under way, or Drive finished and this account's access has not
 * verified yet. Never Available until the requester's own account verifies it.
 * Returns true once the bounded checks for the current state are used up.
 */
export function useAccessWatch({ meetings, outcomes, active, revision, refresh }: {
  meetings: Meeting[]; outcomes: Record<string, MeetingRequestOutcome>;
  active: boolean; revision: number; refresh: () => void;
}): boolean {
  const watched = meetings.flatMap(meeting =>
    (outcomes[meeting.occurrence_id]?.requests || [])
      .filter(item => WAITING_STATUSES.includes(item.status) || item.status === "approved" ||
        (!meeting.artifact_kinds.length && (item.status === "completed" || item.status === "partial")))
      .map(item => ({ key: `${item.requestId}:${item.status}`, waiting: WAITING_STATUSES.includes(item.status) })));
  const watch = watched.map(item => item.key).join("|");
  // Fast while sharing or verification is under way; slow while only the organizer is awaited.
  const delay = watched.some(item => !item.waiting) ? ACCESS_RECHECK_MS : WAITING_RECHECK_MS;
  // Counted per watched state, so a new request or a new phase gets its own bounded checks.
  const [checks, setChecks] = useState({ watch: "", count: 0 });
  const exhausted = (checks.watch === watch ? checks.count : 0) >= ACCESS_RECHECK_LIMIT;
  useEffect(() => {
    if (!watch || exhausted || !active) return;
    const timer = window.setTimeout(() => {
      setChecks(previous => ({ watch, count: previous.watch === watch ? previous.count + 1 : 1 }));
      refresh();
    }, delay);
    return () => window.clearTimeout(timer);
  }, [watch, delay, exhausted, active, revision, refresh]);
  return exhausted;
}
