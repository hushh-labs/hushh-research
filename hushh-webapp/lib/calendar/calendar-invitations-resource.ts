import { CacheService } from "@/lib/services/cache-service";
import { subscribeVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { GoogleCalendarError, GoogleCalendarService, type CalendarInvitationsResponse } from "@/lib/services/google-calendar-service";

const PREFIX = "calendar_invitations_";
const TTL = 60_000;
let subscribed = false;

export function invitationResourceKey(owner: string, context: readonly unknown[]) {
  if (!subscribed && typeof window !== "undefined") {
    subscribed = true;
    subscribeVaultSessionEpoch(() => CacheService.getInstance().invalidatePattern(PREFIX));
  }
  return `${PREFIX}${owner}_${JSON.stringify(context)}`;
}

export function invitationSnapshot(key: string) {
  return key ? CacheService.getInstance().peek<CalendarInvitationsResponse>(key) : null;
}

export function invalidateInvitationSnapshots(owner: string) {
  CacheService.getInstance().invalidatePattern(`${PREFIX}${owner}_`);
}

/** Private invitation snapshots are short-lived and memory-only. */
export async function loadInvitationResource(key: string, params: Parameters<typeof GoogleCalendarService.invitations>[0], accountEmail?: string | null, force = false) {
  const cached = invitationSnapshot(key);
  if (!force && cached?.isFresh) return cached.data;
  const result = await GoogleCalendarService.invitations(params);
  if (accountEmail && result.account_email && accountEmail.toLowerCase() !== result.account_email.toLowerCase()) {
    throw new GoogleCalendarError("The connected Calendar account changed. Load this invitation again.", "calendar_connection_changed", 409);
  }
  if (key && !params.signal?.aborted && params.isEffectCurrent?.()) CacheService.getInstance().set(key, result, TTL);
  return result;
}
