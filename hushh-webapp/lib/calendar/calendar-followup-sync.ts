import { CalendarFollowupsService, type FollowupStatus } from "@/lib/services/calendar-followups-service";

/**
 * Re-point one account's monitor at the live Mail grant. It keeps the owner's
 * period, reminder timing, decisions and scan progress; only the grant changes,
 * and reminders are switched on when background delivery is available.
 */
export async function rebindFollowupMonitor(
  userId: string, accountId: string, current: FollowupStatus, zone: string,
  idToken: string, ownerToken: string, signal?: AbortSignal,
): Promise<void> {
  await CalendarFollowupsService.post("preferences", {
    user_id: userId, account_id: accountId, enabled: true,
    // Reminders are automatic wherever background delivery exists.
    notifications_enabled: current.notifications_enabled || Boolean(current.background_available),
    historical_start_at: current.historical_start_at,
    time_zone: current.time_zone || zone,
    reminder_lead_days: current.reminder_lead_days ?? 1,
    reminder_hour: current.reminder_hour ?? 9,
  }, idToken, ownerToken, signal);
}

// One slow or failed call (a proxy timeout, a brief outage) must not end the
// catch-up for the whole visit; only a run of failures does.
const MAX_CONSECUTIVE_SCAN_FAILURES = 3;

/**
 * Each scan call is one bounded step on the server. Keep asking while it reports
 * more work, refreshing between calls so results appear as they land. Returns
 * false when the caller went away before the work finished.
 */
export async function scanWhilePending(options: {
  userId: string; accountId: string; ownerToken: string; maxCalls: number;
  getIdToken: () => Promise<string>; refresh: () => Promise<void>; signal?: AbortSignal;
}): Promise<boolean> {
  let failures = 0;
  for (let call = 0; call < options.maxCalls; call += 1) {
    if (options.signal?.aborted) return false;
    let result: Awaited<ReturnType<typeof CalendarFollowupsService.scan>>;
    try {
      result = await CalendarFollowupsService.scan(
        options.userId, options.accountId, await options.getIdToken(), options.ownerToken, {}, options.signal,
      );
    } catch (failure) {
      if (options.signal?.aborted) return false;
      failures += 1;
      if (failures >= MAX_CONSECUTIVE_SCAN_FAILURES) throw failure;
      await options.refresh();
      continue;
    }
    failures = 0;
    await options.refresh();
    if (result?.state !== "pending") return true;
  }
  return true;
}
