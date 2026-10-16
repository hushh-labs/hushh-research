import { invalidateInvitationSnapshots } from "./calendar-invitations-resource";
import { CacheService } from "@/lib/services/cache-service";

export const calendarRefreshKey = (ownerId: string) => `calendar-schedule-refresh:${ownerId}`;

/** Publish only after the provider confirms a mutation; invitation snapshots are invalidated. */
export function notifyCalendarChanged(ownerId: string) {
  invalidateInvitationSnapshots(ownerId);
  CacheService.getInstance().set(calendarRefreshKey(ownerId), Date.now(), 60_000);
}
