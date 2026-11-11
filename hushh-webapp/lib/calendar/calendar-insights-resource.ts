import { subscribeAuthSessionGeneration } from "@/lib/auth/session-owner";
import { CacheService } from "@/lib/services/cache-service";
import type { MeetingLibrary } from "@/lib/services/calendar-insights-service";
import { subscribeVaultSessionEpoch } from "@/lib/vault/session-epoch";

const PREFIX = "calendar_insights_";
const TTL_MS = 60_000;
const MAX_STALE_MS = 5 * 60_000;
let subscribed = false;
type PendingRead = { controller: AbortController; readers: number; promise: Promise<unknown> };
const pendingReads = new Map<string, PendingRead>();
function cancelPendingReads() {
  for (const entry of pendingReads.values()) entry.controller.abort();
  pendingReads.clear();
}

/** Share an active owner/context read; cancel the transport after its last reader leaves. */
export function coalescedInsightsRead<T>(key: string, signal: AbortSignal, load: (signal: AbortSignal) => Promise<T>): Promise<T> {
  if (signal.aborted) return Promise.reject(new DOMException("Calendar read cancelled", "AbortError"));
  let entry = pendingReads.get(key);
  if (!entry || entry.controller.signal.aborted) {
    const controller = new AbortController();
    entry = { controller, readers: 0, promise: load(controller.signal) };
    pendingReads.set(key, entry);
    const settled = entry;
    void entry.promise.then(
      () => { if (pendingReads.get(key) === settled) pendingReads.delete(key); },
      () => { if (pendingReads.get(key) === settled) pendingReads.delete(key); },
    );
  }
  const active = entry;
  active.readers += 1;
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const finish = () => {
      if (done) return false;
      done = true;
      signal.removeEventListener("abort", onAbort);
      active.readers -= 1;
      if (active.readers === 0 && pendingReads.get(key) === active) active.controller.abort();
      return true;
    };
    const onAbort = () => {
      if (finish()) reject(new DOMException("Calendar read cancelled", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void active.promise.then(
      value => { if (finish()) resolve(value as T); },
      error => { if (finish()) reject(error); },
    );
  });
}

/** Owner and grant scoped metadata only; file actions always check live authority. */
export function insightsResourceKey(owner: string, context: readonly unknown[]) {
  if (!subscribed && typeof window !== "undefined") {
    subscribed = true;
    subscribeVaultSessionEpoch(() => { cancelPendingReads(); CacheService.getInstance().invalidatePattern(PREFIX); });
    subscribeAuthSessionGeneration(() => { cancelPendingReads(); CacheService.getInstance().invalidatePattern(PREFIX); });
  }
  return `${PREFIX}${owner}_${JSON.stringify(context)}`;
}

export function insightsSnapshot<T>(key: string): T | null {
  const snapshot = CacheService.getInstance().peek<T>(key);
  return snapshot && snapshot.ageMs <= MAX_STALE_MS ? snapshot.data : null;
}

export function storeInsightsSnapshot<T>(key: string, value: T) {
  CacheService.getInstance().set(key, value, TTL_MS);
}

export function invalidateInsightsSnapshots(owner: string) {
  CacheService.getInstance().invalidatePattern(`${PREFIX}${owner}_`);
}

export function mergeLibrary(previous: MeetingLibrary | null, incoming: MeetingLibrary): MeetingLibrary {
  if (!previous) return incoming;
  const meetings = new Map(previous.meetings.map(meeting => [meeting.occurrence_id, meeting]));
  for (const meeting of incoming.meetings) {
    const older = meetings.get(meeting.occurrence_id);
    if (!older) { meetings.set(meeting.occurrence_id, meeting); continue; }
    const sources = new Map([...older.sources, ...meeting.sources].map(source => [source.calendar_id + ":" + source.event_id, source]));
    const artifactKinds = Array.from(new Set([...older.artifact_kinds, ...meeting.artifact_kinds]));
    meetings.set(meeting.occurrence_id, {
      ...older, artifact_kinds: artifactKinds,
      availability: Object.fromEntries((["recording", "notes"] as const).map(kind => [kind,
        artifactKinds.includes(kind) ? "available" : meeting.availability[kind] || older.availability[kind] || "unverified"])),
      discovery: meeting.discovery === "checked" ? meeting.discovery : older.discovery,
      file_state: artifactKinds.length ? "available" : meeting.file_state,
      sources: Array.from(sources.values()),
    });
  }
  const limitationSet = new Set([...previous.limitations, ...incoming.limitations]);
  if (!incoming.next_cursor) limitationSet.delete("request_budget");
  const limitations = Array.from(limitationSet);
  return {
    ...incoming, meetings: Array.from(meetings.values()).sort((left, right) =>
      Date.parse(right.start?.dateTime || "") - Date.parse(left.start?.dateTime || "")),
    limitations,
    complete: incoming.complete && limitations.length === 0,
    checked_events: previous.checked_events + incoming.checked_events,
  };
}
