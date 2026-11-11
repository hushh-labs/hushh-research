"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { Button } from "@/components/ui/button";
import { describeLiveActivity } from "@/lib/pkm/live-activity/live-activity-copy";
import { peekLiveActivity, subscribeLiveActivity } from "@/lib/pkm/live-activity/live-activity-journal";
import type { LiveActivityEvent } from "@/lib/pkm/live-activity/live-activity-types";

const PAGE_SIZE = 8;
const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

function startOfToday(now: number): number {
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

function nextMidnight(dayStart: number): number {
  const next = new Date(dayStart);
  next.setHours(24, 0, 0, 0);
  return next.getTime();
}

/** The owner's events today, refreshed on journal changes and at each local midnight. */
function useTodayEvents(userId: string | null): readonly LiveActivityEvent[] {
  const [, setTick] = useState(0);
  const [since, setSince] = useState(() => startOfToday(Date.now()));
  useEffect(() => subscribeLiveActivity(() => setTick(tick => tick + 1)), []);
  useEffect(() => {
    const midnight = nextMidnight(since);
    // A timer that fires early still moves to the new day, so it is always re-armed.
    const timer = setTimeout(() => setSince(startOfToday(Math.max(Date.now(), midnight))),
      Math.max(0, midnight - Date.now()));
    return () => clearTimeout(timer);
  }, [since]);
  if (!userId) return [];
  return peekLiveActivity(userId).filter(event => event.lastAt >= since);
}

/** How many rows the signed-in owner's Today group shows (0 when it renders nothing). */
export function useLiveActivityTodayCount(): number {
  const { userId } = useAuth();
  return useTodayEvents(userId).length;
}

function activityTitle(event: LiveActivityEvent): string {
  const line = describeLiveActivity(event);
  return event.count > 1 ? `${line} · ${event.count} times` : line;
}

function ActivityRow({ event }: { event: LiveActivityEvent }) {
  return (
    <SettingsRow title={activityTitle(event)} trailing={
      <time dateTime={new Date(event.lastAt).toISOString()}>{timeFormat.format(event.lastAt)}</time>
    } />
  );
}

/** One owner's activity today, newest first. Paging never carries across owners. */
function TodayList({ userId }: { userId: string }) {
  const [limit, setLimit] = useState(PAGE_SIZE);
  const events = useTodayEvents(userId);
  if (events.length === 0) return null;
  return (
    <div className="min-w-0">
      <SettingsGroup title="Today" embedded separatorInset headingClassName="mt-0">
        {events.slice(0, limit).map(event => <ActivityRow key={event.id} event={event} />)}
      </SettingsGroup>
      {events.length > limit ? (
        <div className="flex justify-center pt-2">
          <Button type="button" variant="secondary" size="standard" aria-label="Show more activity"
            onClick={() => setLimit(current => current + PAGE_SIZE)}>Show more</Button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Profile > Memory > History "Today": what the owner did in One today on this
 * device, read from the encrypted live activity journal. Nothing renders when
 * there is no owner or no activity today.
 */
export function LiveActivityToday() {
  const { userId } = useAuth();
  if (!userId) return null;
  return <TodayList key={userId} userId={userId} />;
}
