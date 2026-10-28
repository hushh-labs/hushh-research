import { ownerContentIsPrivate } from './private-agent-specialist-chat';
import { privateGoogleStatus, disconnectPrivateGoogle, confirmPrivateGoogleAction, requireSharedGoogleExchange, PrivateGoogleUnsupportedError } from './private-google-connections';
import { ApiService } from "@/lib/services/api-service";
import type { GoogleConnectionStatus } from "@/lib/services/google-connection-service";
import { GoogleCalendarError, calendarError, scheduleRead, scheduleRequest, type CalendarSource } from "@/lib/services/google-calendar-transport";
export { GoogleCalendarError } from "@/lib/services/google-calendar-transport";
export type { CalendarReadRecovery, CalendarSource } from "@/lib/services/google-calendar-transport";

export type GoogleCalendarAccount = {
  account_id: string;
  google_email: string | null;
  google_email_verified?: boolean;
  profile_photo_url?: string | null;
  status: "connected" | "needs_reauth" | "disconnected";
  connected: boolean;
  access_level: "read" | "manage" | null;
  calendar_list_access: boolean;
  guest_photo_access?: boolean;
  scope_csv?: string;
  grant_generation?: string;
  provider_subject_sha256?: string;
  hosted_domain?: string | null;
};
export type GoogleCalendarStatus = GoogleConnectionStatus & {
  accounts?: GoogleCalendarAccount[];
  account_limit?: number;
};

type OAuthStart = {
  authorize_url: string;
  redirect_uri: string;
  expires_at: string;
};
type NativeOAuthStart = {
  configured: boolean;
  server_client_id: string;
  service: "calendar";
  access_level: "read" | "manage";
  state: string;
  include_calendar_list?: boolean;
  include_guest_photos?: boolean;
  include_meeting_files?: boolean;
};

export type CalendarExecution = {
  action: "create" | "reschedule" | "cancel";
  event: {
    id?: string | null;
    title?: string | null;
    start?: { dateTime?: string; date?: string } | null;
    end?: { dateTime?: string; date?: string } | null;
    status?: string | null;
    conference_url?: string | null;
    conference_status?: string | null;
  };
};

export type CalendarEventTime = { dateTime?: string; date?: string; timeZone?: string } | null;

/**
 * The RAW backend event shape (matches _event_summary() in
 * hushh_mcp/services/google_calendar_service.py exactly, including
 * description/location/attendees). listEvents() below returns this
 * unredacted for the authenticated owner workspace. Chat redaction remains
 * lib/calendar/use-calendar-upcoming-events.ts's responsibility.
 */
export type CalendarEventSummary = {
  account_id?: string;
  account_email?: string;
  id?: string | null;
  etag?: string | null;
  calendar_id?: string;
  source_calendar_id?: string;
  source_time_zone?: string | null;
  calendar_name?: string;
  calendar_color?: string | null;
  event_color?: string | null;
  color_id?: string | null;
  conference_name?: string | null;
  conference_icon?: string | null;
  organizer?: { email?: string; displayName?: string; self?: boolean };
  can_decline?: boolean;
  title: string;
  description?: string | null;
  location?: string | null;
  start: CalendarEventTime;
  end: CalendarEventTime;
  status?: string | null;
  event_type?: string | null;
  attendees?: { email?: string | null; response_status?: string | null; display_name?: string | null; self?: boolean }[];
  html_link?: string | null;
  conference_url?: string | null;
  conference_status?: string | null;
  updated?: string | null;
  transparency?: string | null;
  ical_uid?: string | null;
  original_start_time?: CalendarEventTime;
};

export type CalendarEventsResponse = {
  events: CalendarEventSummary[];
  time_zone?: string | null;
};

export type CalendarOpening = { start_at: string; end_at: string; available_until?: string };
export type CalendarDailyResponse = CalendarEventsResponse & { date: string; time_zone: string; calendars: CalendarSource[]; unreadable_calendars: CalendarSource[]; calendar_options?: CalendarSource[] };
export type CalendarAvailability = { windows: (CalendarOpening & { duration_minutes: number })[]; full_count: number; requested_duration_minutes: number; time_zone: string; date: string; time_min: string; time_max: string; calendars: CalendarSource[]; calendar_options?: CalendarSource[] };
export type CalendarBoardAccount = {
  account_id: string;
  google_email: string;
  profile_photo_url?: string | null;
  connection_status: string;
  status: "complete" | "incomplete" | "needs_reauth";
  events: CalendarEventSummary[];
  calendars?: CalendarSource[];
  calendar_options?: CalendarSource[];
  unreadable_calendars: CalendarSource[];
  free_windows: CalendarOpening[];
  checked_at?: string;
  error?: string;
  reason_code?: string;
};
export type CalendarBoardConflict = {
  left: { account_id: string; calendar_id: string; event_id: string };
  right: { account_id: string; calendar_id: string; event_id: string };
  start_at: string;
  end_at: string;
};
export type CalendarBoardDay = {
  date: string; time_zone: string; duration_minutes: 15 | 30 | 60;
  accounts: CalendarBoardAccount[]; complete: boolean; conflicts_complete: boolean;
  conflicts: CalendarBoardConflict[]; shared_free_windows: CalendarOpening[]; checked_at: string;
};
export type CalendarEventRef = { account_id: string; calendar_id: string; event_id: string };
export type CalendarConflictPreview = {
  kind: "keep" | "decline"; ref: CalendarEventRef; title: string;
  account_email: string; start: CalendarEventTime; end: CalendarEventTime;
  action: string; recipient?: string; sender_label?: string; subject?: string; message?: string;
};
export type CalendarConflictReview = {
  review_id: string; review_token: string; expires_at: string; previews: CalendarConflictPreview[];
};
export type CalendarConflictOutcome = {
  kind: "keep" | "decline"; ref: CalendarEventRef;
  calendar: "kept" | "accepted" | "declined" | "failed" | "unknown";
  email: "not_sent" | "sent" | "failed" | "unknown";
  calendar_error?: string | null; email_error?: string | null; error?: string;
};
export type CalendarConflictResult = { results: CalendarConflictOutcome[]; complete: boolean };
export type CalendarInvitation = CalendarEventSummary & { id: string; calendar_id: string; response_status: "needsAction" | "accepted" | "declined" | "tentative"; can_respond: boolean; conflicts: CalendarEventSummary[] };
export type CalendarInvitationsResponse = { account_email?: string; events: CalendarInvitation[]; pending_count: number; time_zone: string; start_at: string; end_at: string; complete: boolean; unreadable_calendars: CalendarSource[] };
export type CalendarAttendanceReview = { exact_time?: boolean; response_status?: "accepted" | "declined" | "tentative"; calendar_id?: string; conflicts?: CalendarEventSummary[]; unchecked_calendars?: string[]; openings?: CalendarOpening[]; review_id: string; review_token: string; title: string; start?: CalendarEventTime; end?: CalendarEventTime; recipient: string | null; subject: string | null; message: string | null; rescheduling_link: string | null; sender_label: string | null; expires_at: string };
export type CalendarAttendanceResult = { calendar: "accepted" | "declined" | "tentative" | "failed" | "unknown"; email: "not_sent" | "sent" | "failed" | "unknown"; calendar_error: string | null; email_error: string | null };
export type CalendarWindowParams = { vaultOwnerToken: string; date: string; timeZone: string; startTime: string; endTime: string; durationMinutes: 15 | 30 | 60 };
type AttendanceReviewInput = Omit<CalendarWindowParams, "durationMinutes"> & { durationMinutes: number; accountId?: string; expectedAccountEmail?: string; responseStatus?: "accepted" | "declined" | "tentative"; firebaseIdToken: string; signal?: AbortSignal; isEffectCurrent?: () => boolean; eventId: string; calendarId?: string; offerTimes: boolean; sendMessage?: boolean; mailOnlyRetry?: boolean; exactTime?: boolean; message: string };

/** Typed transport for the Calendar API. Components never call fetch directly. */
export class GoogleCalendarService {
  static async status(
    idToken: string,
    userId: string,
  ): Promise<GoogleCalendarStatus> {
    if (await ownerContentIsPrivate()) {
      const value = await privateGoogleStatus('calendar');
      return { configured: true, connected: value.status === 'connected' && value.capabilities.read, status: value.status === 'absent' ? 'disconnected' : value.status === 'connected' && !value.capabilities.read ? 'needs_reauth' : value.status, access_level: value.accessLevel, scope_csv: '' };
    }
    const response = await ApiService.apiFetch(
      `/api/one/calendar/status/${encodeURIComponent(userId)}`,
      {
        headers: { Authorization: `Bearer ${idToken}` },
      },
    );
    if (!response.ok)
      throw await calendarError(response, "Unable to load Calendar connection.");
    return response.json() as Promise<GoogleCalendarStatus>;
  }

  static async startConnect(params: {
    idToken: string;
    userId: string;
    accessLevel: "read" | "manage";
    additional?: boolean;
    accountId?: string;
    loginHint?: string;
    includeMeetingFiles?: boolean;
  }): Promise<OAuthStart> {
    await requireSharedGoogleExchange();
    const response = await ApiService.apiFetch(
      "/api/one/calendar/connect/start",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${params.idToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          user_id: params.userId,
          access_level: params.accessLevel,
          ...(params.additional ? { additional: true } : {}),
          ...(params.accountId ? { account_id: params.accountId } : {}),
          ...(params.loginHint ? { login_hint: params.loginHint } : {}),
          ...(params.includeMeetingFiles ? { include_meeting_files: true } : {}),
          redirect_uri: typeof window === "undefined" ? undefined
            : `${window.location.origin}/one/profile/google/oauth/return`,
        }),
      },
    );
    if (!response.ok)
      throw await calendarError(response, "Unable to start Calendar connection.");
    return response.json() as Promise<OAuthStart>;
  }

  static async completeConnect(params: {
    idToken: string;
    userId: string;
    code: string;
    state: string;
  }): Promise<GoogleCalendarStatus> {
    await requireSharedGoogleExchange();
    const response = await ApiService.apiFetch(
      "/api/one/calendar/connect/complete",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${params.idToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          user_id: params.userId,
          code: params.code,
          state: params.state,
          redirect_uri: typeof window === "undefined" ? undefined
            : `${window.location.origin}/one/profile/google/oauth/return`,
        }),
      },
    );
    if (!response.ok)
      throw await calendarError(response, "Unable to finish Calendar connection.");
    return response.json() as Promise<GoogleCalendarStatus>;
  }

  static async startNativeConnect(params: {
    idToken: string;
    accessLevel: "read" | "manage";
    includeCalendarList?: boolean;
    includeMeetingFiles?: boolean;
    additional?: boolean;
    accountId?: string;
  }): Promise<NativeOAuthStart> {
    await requireSharedGoogleExchange();
    const response = await ApiService.apiFetch(
      "/api/one/calendar/connect/native/start",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${params.idToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ access_level: params.accessLevel, ...(params.includeCalendarList ? { include_calendar_list: true } : {}), ...(params.includeMeetingFiles ? { include_meeting_files: true } : {}), ...(params.additional ? { additional: true } : {}), ...(params.accountId ? { account_id: params.accountId } : {}) }),
      },
    );
    if (!response.ok)
      throw await calendarError(response, "Unable to start Calendar connection.");
    const start = (await response.json()) as NativeOAuthStart;
    if (typeof start.state !== "string" || !start.state.trim()) {
      throw new Error(
        "Google connection could not be prepared. Please try again.",
      );
    }
    return start;
  }

  static async completeNativeConnect(params: {
    idToken: string;
    userId: string;
    accessLevel: "read" | "manage";
    serverAuthCode: string;
    state: string;
  }): Promise<GoogleCalendarStatus> {
    await requireSharedGoogleExchange();
    if (!params.state.trim()) {
      throw new Error("Restart the Google connection to continue.");
    }
    const response = await ApiService.apiFetch(
      "/api/one/calendar/connect/native/complete",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${params.idToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          user_id: params.userId,
          access_level: params.accessLevel,
          server_auth_code: params.serverAuthCode,
          state: params.state,
        }),
      },
    );
    if (!response.ok)
      throw await calendarError(response, "Unable to finish Calendar connection.");
    return response.json() as Promise<GoogleCalendarStatus>;
  }

  static async disconnect(
    idToken: string,
    userId: string,
    accountId = "default",
  ): Promise<GoogleCalendarStatus> {
    if (await ownerContentIsPrivate()) {
      await disconnectPrivateGoogle('calendar');
      return this.status(idToken, userId);
    }
    const response = await ApiService.apiFetch("/api/one/calendar/disconnect", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${idToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ user_id: userId, account_id: accountId }),
    });
    if (!response.ok)
      throw await calendarError(response, "Unable to disconnect Calendar.");
    const status = await response.json() as GoogleCalendarStatus;
    if (status.accounts?.some(account => account.account_id === accountId && account.connected)) throw new GoogleCalendarError("Calendar disconnection could not be verified.", null, 502);
    if (!status.accounts && status.connected !== false) throw new GoogleCalendarError("Calendar disconnection could not be verified.", null, 502);
    return status;
  }

  /** Execute one short-lived Calendar proposal after an owner confirms it in chat. */
  static async executeProposal(params: {
    vaultOwnerToken: string;
    userId: string;
    proposalId: string;
  }): Promise<CalendarExecution> {
    if (await ownerContentIsPrivate()) {
      const value = await confirmPrivateGoogleAction(params.proposalId, 'calendar');
      if (!['create', 'reschedule', 'cancel'].includes(String(value.action)) || !value.event || typeof value.event !== 'object') throw new Error('Your agent could not confirm the Calendar outcome.');
      return value as CalendarExecution;
    }
    const response = await ApiService.apiFetch(
      "/api/one/calendar/proposals/execute",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${params.vaultOwnerToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          user_id: params.userId,
          proposal_id: params.proposalId,
        }),
      },
    );
    if (!response.ok)
      throw await calendarError(response, "Unable to apply Calendar change.");
    return response.json() as Promise<CalendarExecution>;
  }

  /**
   * List the caller's own upcoming events in a time range. Mirrors
   * executeProposal's vaultOwnerToken-auth shape, not status's idToken
   * shape -- POST /api/one/calendar/events is
   * Depends(require_vault_owner_token) (api/routes/one/calendar.py),
   * unlike status/connect/disconnect. user_id is derived from the
   * validated token server-side, so it is not sent here.
   *
   * The REST route ignores calendar filtering and result-count caps for
   * this endpoint -- list_events() always queries the primary calendar
   * with an internal default/cap server-side -- so no calendarIds or
   * maxResults param is exposed here; it would promise a capability the
   * backend doesn't honor.
   */
  static async listEvents(params: {
    vaultOwnerToken: string;
    startAt: string;
    endAt: string;
  }): Promise<CalendarEventsResponse> {
    if (await ownerContentIsPrivate()) throw new PrivateGoogleUnsupportedError('This Calendar event list');
    const response = await ApiService.apiFetch("/api/one/calendar/events", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${params.vaultOwnerToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        start_at: params.startAt,
        end_at: params.endAt,
      }),
    });
    if (!response.ok)
      throw await calendarError(response, "Unable to load Calendar events.");
    return response.json() as Promise<CalendarEventsResponse>;
  }
  static async today(params: { firebaseIdToken: string; signal?: AbortSignal; isEffectCurrent?: () => boolean; date: string; timeZone: string }): Promise<CalendarDailyResponse> {
    const result = await scheduleRead<CalendarDailyResponse>("schedule/today", { date: params.date, time_zone: params.timeZone }, params);
    if (!result || result.date !== params.date || result.time_zone !== params.timeZone || !Array.isArray(result.events) || !Array.isArray(result.calendars) || !result.calendars.length || !Array.isArray(result.unreadable_calendars)) throw new GoogleCalendarError("Calendar events could not be checked.", "calendar_invalid_response", 502);
    return result;
  }

  private static windowBody(params: Omit<CalendarWindowParams, "vaultOwnerToken" | "durationMinutes"> & { durationMinutes: number }) {
    return { date: params.date, time_zone: params.timeZone, start_time: params.startTime, end_time: params.endTime, duration_minutes: params.durationMinutes };
  }

  private static isFullLocalDay(result: CalendarAvailability, date: string, zone: string) {
    try {
      if (typeof result.time_min !== "string" || typeof result.time_max !== "string") return false;
      const start = Date.parse(result.time_min), end = Date.parse(result.time_max);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return false;
      const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" });
      const day = (instant: number) => {
        const parts = formatter.formatToParts(new Date(instant));
        return ["year", "month", "day"].map(type => parts.find(part => part.type === type)!.value.padStart(type === "year" ? 4 : 2, "0")).join("-");
      };
      // Verify the civil-date transitions, including skipped/repeated midnight.
      // A clipped 9–5 response or a rolling 24-hour response cannot pass.
      return day(start) === date && day(start - 1) < date && day(end - 1) === date && day(end) > date;
    } catch { return false; }
  }

  static async availability(params: Omit<CalendarWindowParams, "vaultOwnerToken"> & { calendarOverrides?: Record<string, boolean>; firebaseIdToken: string; signal?: AbortSignal; isEffectCurrent?: () => boolean }): Promise<CalendarAvailability> {
    const result = await scheduleRead<CalendarAvailability>("schedule/availability", { ...this.windowBody({ ...params, startTime: "00:00", endTime: "24:00" }), ...(params.calendarOverrides && Object.keys(params.calendarOverrides).length ? { calendar_overrides: params.calendarOverrides } : {}) }, params);
    if (!result || !this.isFullLocalDay(result, params.date, params.timeZone) || result.date !== params.date || result.time_zone !== params.timeZone || !Array.isArray(result.windows) || result.windows.length > 3 || !Number.isInteger(result.full_count) || result.full_count < result.windows.length || result.requested_duration_minutes !== params.durationMinutes || !Array.isArray(result.calendars) || !result.calendars.length || result.windows.some(window => !Number.isFinite(Date.parse(window.start_at)) || !Number.isFinite(Date.parse(window.end_at)) || Date.parse(window.end_at) <= Date.parse(window.start_at) || Date.parse(window.start_at) < Date.parse(result.time_min) || Date.parse(window.end_at) > Date.parse(result.time_max) || window.duration_minutes < params.durationMinutes || Math.floor((Date.parse(window.end_at) - Date.parse(window.start_at)) / 60000) !== window.duration_minutes)) throw new GoogleCalendarError("Availability could not be checked.", "calendar_invalid_response", 502);
    return result;
  }

  static async invitations(params: { firebaseIdToken: string; timeZone: string; accountId?: string; selectedCalendarId?: string; selectedEventId?: string; startAt?: string; endAt?: string; signal?: AbortSignal; isEffectCurrent?: () => boolean }): Promise<CalendarInvitationsResponse> {
    const result = await scheduleRead<CalendarInvitationsResponse>("invitations", { time_zone: params.timeZone, ...(params.accountId && params.accountId !== "default" ? { account_id: params.accountId } : {}), ...(params.selectedCalendarId ? { selected_calendar_id: params.selectedCalendarId } : {}), ...(params.selectedEventId ? { selected_event_id: params.selectedEventId } : {}), ...(params.startAt ? { start_at: params.startAt } : {}), ...(params.endAt ? { end_at: params.endAt } : {}) }, params);
    if (!result || !Array.isArray(result.events) || !Number.isInteger(result.pending_count) || !Array.isArray(result.unreadable_calendars) || result.events.some(event => !event.id || !event.calendar_id || !["needsAction", "accepted", "declined", "tentative"].includes(event.response_status))) throw new GoogleCalendarError("Invitations could not be checked.", "calendar_invalid_response", 502);
    return result;
  }

  private static attendanceReviewBody(params: Omit<AttendanceReviewInput, "vaultOwnerToken">) {
    return { ...this.windowBody(params), ...(params.accountId && params.accountId !== "default" ? { account_id: params.accountId } : {}), event_id: params.eventId, calendar_id: params.calendarId || "primary", offer_times: params.offerTimes, send_message: params.sendMessage ?? false, mail_only_retry: params.mailOnlyRetry ?? false, exact_time: params.exactTime ?? false, message: params.message, ...(params.expectedAccountEmail ? { expected_account_email: params.expectedAccountEmail } : {}), ...(params.responseStatus ? { response_status: params.responseStatus } : {}) };
  }

  static reviewAttendance(params: AttendanceReviewInput): Promise<CalendarAttendanceReview> {
    return scheduleRequest("attendance/review", params.vaultOwnerToken, this.attendanceReviewBody(params), params);
  }

  static reviewWorkspaceAttendance(params: Omit<AttendanceReviewInput, "vaultOwnerToken">): Promise<CalendarAttendanceReview> {
    return scheduleRequest("attendance/workspace/review", null, this.attendanceReviewBody(params), params);
  }

  static reviewRsvp(params: { firebaseIdToken: string; eventId: string; calendarId: string; accountId?: string; expectedAccountEmail?: string; responseStatus: "accepted" | "declined"; timeZone: string; isEffectCurrent?: () => boolean }): Promise<CalendarAttendanceReview> {
    return scheduleRequest("attendance/rsvp/review", null, {
      event_id: params.eventId, calendar_id: params.calendarId,
      ...(params.accountId && params.accountId !== "default" ? { account_id: params.accountId } : {}),
      ...(params.expectedAccountEmail ? { expected_account_email: params.expectedAccountEmail } : {}),
      response_status: params.responseStatus, time_zone: params.timeZone,
    }, params);
  }

  static async confirmRsvp(params: { firebaseIdToken: string; accountId?: string; reviewId: string; reviewToken: string; isEffectCurrent?: () => boolean }): Promise<CalendarAttendanceResult> {
    const result = await scheduleRequest<CalendarAttendanceResult>("attendance/rsvp/confirm", null, {
      ...(params.accountId && params.accountId !== "default" ? { account_id: params.accountId } : {}),
      review_id: params.reviewId, review_token: params.reviewToken,
    }, params);
    return this.validatedAttendanceResult(result);
  }

  static async confirmWorkspaceAttendance(params: { firebaseIdToken: string; accountId?: string; reviewId: string; reviewToken: string; isEffectCurrent?: () => boolean }): Promise<CalendarAttendanceResult> {
    const result = await scheduleRequest<CalendarAttendanceResult>("attendance/workspace/confirm", null, {
      ...(params.accountId && params.accountId !== "default" ? { account_id: params.accountId } : {}),
      review_id: params.reviewId, review_token: params.reviewToken,
    }, params);
    return this.validatedAttendanceResult(result);
  }

  private static validatedAttendanceResult(result: CalendarAttendanceResult): CalendarAttendanceResult {
    if (!result || !["accepted", "declined", "tentative", "failed", "unknown"].includes(result.calendar) || !["sent", "not_sent", "failed", "unknown"].includes(result.email)) throw new GoogleCalendarError("Calendar did not confirm the outcome. Check Calendar and Sent Mail before retrying.", "calendar_invalid_response", 502);
    return result;
  }

  static async confirmAttendance(params: { firebaseIdToken: string; signal?: AbortSignal; isEffectCurrent?: () => boolean; vaultOwnerToken: string; accountId?: string; reviewId: string; reviewToken: string }): Promise<CalendarAttendanceResult> {
    const result = await scheduleRequest<CalendarAttendanceResult>("attendance/confirm", params.vaultOwnerToken, { ...(params.accountId && params.accountId !== "default" ? { account_id: params.accountId } : {}), review_id: params.reviewId, review_token: params.reviewToken }, params);
    return this.validatedAttendanceResult(result);
  }

  static async boardDay(params: { firebaseIdToken: string; date: string; timeZone: string; durationMinutes: 15 | 30 | 60; calendarOverridesByAccount?: Record<string, Record<string, boolean>>; signal?: AbortSignal; isEffectCurrent?: () => boolean }): Promise<CalendarBoardDay> {
    const result = await scheduleRead<CalendarBoardDay>("board/day", { date: params.date, time_zone: params.timeZone, duration_minutes: params.durationMinutes, ...(params.calendarOverridesByAccount ? { calendar_overrides_by_account: params.calendarOverridesByAccount } : {}) }, params);
    if (!result || result.date !== params.date || result.time_zone !== params.timeZone ||
        !Array.isArray(result.accounts) || result.accounts.length < 1 || result.accounts.length > 3 ||
        !Array.isArray(result.conflicts) || !Array.isArray(result.shared_free_windows) ||
        result.accounts.some(account => !account.account_id || !Array.isArray(account.events) || !Array.isArray(account.free_windows))) {
      throw new GoogleCalendarError("Calendar board could not be checked.", "calendar_invalid_response", 502);
    }
    return result;
  }

  static async reviewConflict(params: { firebaseIdToken: string; vaultOwnerToken: string; date: string; timeZone: string; keep: CalendarEventRef; decline: (CalendarEventRef & { message: string })[]; isEffectCurrent?: () => boolean }): Promise<CalendarConflictReview> {
    const result = await scheduleRequest<CalendarConflictReview>("conflicts/review", params.vaultOwnerToken, {
      date: params.date, time_zone: params.timeZone, keep: params.keep, decline: params.decline,
    }, params);
    if (!result?.review_id || !result.review_token || !Array.isArray(result.previews)) throw new GoogleCalendarError("Conflict review could not be prepared.", "calendar_invalid_response", 502);
    return result;
  }

  static async reviewWorkspaceConflict(params: Omit<Parameters<typeof GoogleCalendarService.reviewConflict>[0], "vaultOwnerToken">): Promise<CalendarConflictReview> {
    const result = await scheduleRequest<CalendarConflictReview>("conflicts/workspace/review", null, {
      date: params.date, time_zone: params.timeZone, keep: params.keep, decline: params.decline,
    }, params);
    if (!result?.review_id || !result.review_token || !Array.isArray(result.previews)) throw new GoogleCalendarError("Conflict review could not be prepared.", "calendar_invalid_response", 502);
    return result;
  }

  static async confirmConflict(params: { firebaseIdToken: string; vaultOwnerToken: string; reviewId: string; reviewToken: string; isEffectCurrent?: () => boolean }): Promise<CalendarConflictResult> {
    const result = await scheduleRequest<CalendarConflictResult>("conflicts/confirm", params.vaultOwnerToken, {
      review_id: params.reviewId, review_token: params.reviewToken,
    }, params);
    if (!result || !Array.isArray(result.results) || typeof result.complete !== "boolean") throw new GoogleCalendarError("Conflict outcome could not be confirmed. Check Calendar and Sent Mail.", "calendar_invalid_response", 502);
    return result;
  }

  static async confirmWorkspaceConflict(params: Omit<Parameters<typeof GoogleCalendarService.confirmConflict>[0], "vaultOwnerToken">): Promise<CalendarConflictResult> {
    const result = await scheduleRequest<CalendarConflictResult>("conflicts/workspace/confirm", null, {
      review_id: params.reviewId, review_token: params.reviewToken,
    }, params);
    if (!result || !Array.isArray(result.results) || typeof result.complete !== "boolean") throw new GoogleCalendarError("Conflict outcome could not be confirmed. Check Calendar and Sent Mail.", "calendar_invalid_response", 502);
    return result;
  }

  static publicReschedulingOptions(token: string): Promise<{ openings: CalendarOpening[]; time_zone: string; reply_to: string; event_link?: string }> {
    return scheduleRequest("rescheduling/options", null, { token });
  }

}
