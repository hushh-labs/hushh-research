import { CacheService } from "@/lib/services/cache-service";

export const calendarRefreshKey = (ownerId: string) => `calendar-schedule-refresh:${ownerId}`;

/** Publish only after the provider confirms a mutation; no event information is cached. */
export function notifyCalendarChanged(ownerId: string) {
  CacheService.getInstance().set(calendarRefreshKey(ownerId), Date.now(), 60_000);
}
