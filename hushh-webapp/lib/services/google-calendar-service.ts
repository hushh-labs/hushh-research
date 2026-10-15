import { ownerContentIsPrivate } from './private-agent-specialist-chat';
import { privateGoogleStatus, disconnectPrivateGoogle, confirmPrivateGoogleAction, requireSharedGoogleExchange, PrivateGoogleUnsupportedError } from './private-google-connections';
import { ApiService } from "@/lib/services/api-service";
import type { GoogleConnectionStatus } from "@/lib/services/google-connection-service";

export type GoogleCalendarStatus = GoogleConnectionStatus;

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

export type CalendarEventTime = { dateTime?: string; date?: string } | null;

/**
 * The RAW backend event shape (matches _event_summary() in
 * hushh_mcp/services/google_calendar_service.py exactly, including
 * description/location/attendees). listEvents() below returns this
 * unredacted for the authenticated owner workspace. Chat redaction remains
 * lib/calendar/use-calendar-upcoming-events.ts's responsibility.
 */
export type CalendarEventSummary = {
  id?: string | null;
  etag?: string | null;
  calendar_id?: string;
  source_calendar_id?: string;
  calendar_name?: string;
  calendar_color?: string | null;
  event_color?: string | null;
  color_id?: string | null;
  conference_name?: string | null;
  conference_icon?: string | null;
  organizer?: { email?: string; self?: boolean };
  can_decline?: boolean;
  title: string;
  description?: string | null;
  location?: string | null;
  start: CalendarEventTime;
  end: CalendarEventTime;
  status?: string | null;
  attendees?: { email?: string | null; response_status?: string | null; self?: boolean }[];
  html_link?: string | null;
  conference_url?: string | null;
  conference_status?: string | null;
  updated?: string | null;
};

export type CalendarEventsResponse = {
  events: CalendarEventSummary[];
  time_zone?: string | null;
};

export type CalendarReadRecovery = "connect" | "reconnect" | "permission" | "retry";

const CALENDAR_RECOVERY: Readonly<Record<string, CalendarReadRecovery>> = {
  calendar_not_connected: "connect",
  calendar_reauthorization_required: "reconnect",
  calendar_permission_required: "permission",
  calendar_list_permission_required: "permission",
  calendar_rate_limited: "retry",
  calendar_timeout: "retry",
  calendar_invalid_response: "retry",
  calendar_connection_changed: "retry",
};

export class GoogleCalendarError extends Error {
  constructor(
    message: string,
    readonly reasonCode: string | null,
    readonly status: number,
    readonly calendarOptions?: CalendarSource[],
  ) {
    super(message);
    this.name = "GoogleCalendarError";
  }

  get recovery(): CalendarReadRecovery {
    return (this.reasonCode && CALENDAR_RECOVERY[this.reasonCode]) || "retry";
  }
}

async function calendarError(response: Response, fallback: string): Promise<GoogleCalendarError> {
  const body = (await response.json().catch(() => null)) as {
    detail?: { message?: string; reason_code?: string; calendar_options?: CalendarSource[] } | string;
  } | null;
  const detail = body?.detail;
  const message = (typeof detail === "string" ? detail : detail?.message) || fallback;
  const reason = typeof detail === "object" && typeof detail?.reason_code === "string"
    ? detail.reason_code : null;
  return new GoogleCalendarError(message, reason, response.status, typeof detail === "object" && Array.isArray(detail?.calendar_options) ? detail.calendar_options : undefined);
}

export type CalendarOpening = { start_at: string; end_at: string; available_until?: string };
export type CalendarSource = { availability_default_included?: boolean; availability_included?: boolean; time_zone?: string | null; id: string; name?: string; primary?: boolean; access_role?: string; background_color?: string | null };
export type CalendarDailyResponse = CalendarEventsResponse & { date: string; time_zone: string; calendars: CalendarSource[]; unreadable_calendars: CalendarSource[]; calendar_options?: CalendarSource[] };
export type CalendarAvailability = { windows: (CalendarOpening & { duration_minutes: number })[]; full_count: number; requested_duration_minutes: number; time_zone: string; date: string; time_min: string; time_max: string; calendars: CalendarSource[]; calendar_options?: CalendarSource[] };
export type CalendarAttendanceReview = { review_id: string; review_token: string; title: string; recipient: string | null; subject: string | null; message: string | null; rescheduling_link: string | null; sender_label: string | null; expires_at: string };
export type CalendarAttendanceResult = { calendar: "declined" | "failed" | "unknown"; email: "not_sent" | "sent" | "failed" | "unknown"; calendar_error: string | null; email_error: string | null };
export type CalendarWindowParams = { vaultOwnerToken: string; date: string; timeZone: string; startTime: string; endTime: string; durationMinutes: 15 | 30 | 60 };

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
        body: JSON.stringify({ access_level: params.accessLevel, ...(params.includeCalendarList ? { include_calendar_list: true } : {}) }),
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
      body: JSON.stringify({ user_id: userId }),
    });
    if (!response.ok)
      throw await calendarError(response, "Unable to disconnect Calendar.");
    const status = await response.json() as GoogleCalendarStatus;
    if (status.connected !== false) throw new GoogleCalendarError("Calendar disconnection could not be verified.", null, 502);
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
  private static async scheduleRequest<T>(path: string, token: string | null, body: object, auth?: { firebaseIdToken: string; signal?: AbortSignal; isEffectCurrent?: () => boolean }): Promise<T> {
    const response = await ApiService.apiFetch(`/api/one/calendar/${path}`, {
      method: "POST", cache: "no-store", signal: auth?.signal, isEffectCurrent: auth?.isEffectCurrent,
      headers: { ...((auth?.firebaseIdToken || token) ? { Authorization: `Bearer ${auth?.firebaseIdToken || token}`, ...(auth && token ? { "X-Hushh-Consent": `Bearer ${token}` } : {}) } : {}), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw await calendarError(response, "Calendar could not complete this request.");
    return response.json() as Promise<T>;
  }

  /** Retry only side-effect-free reads; Calendar mutations must never be replayed. */
  private static async scheduleRead<T>(path: string, body: object, auth: { firebaseIdToken: string; signal?: AbortSignal; isEffectCurrent?: () => boolean }): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      auth.signal?.throwIfAborted();
      if (path === "schedule/availability" && typeof navigator !== "undefined" && !navigator.onLine) throw new GoogleCalendarError("You’re offline. Connect to the internet to check availability.", "calendar_offline", 0);
      if (auth.isEffectCurrent?.() === false) throw new DOMException("Superseded", "AbortError");
      try { return await this.scheduleRequest<T>(path, null, body, auth); }
      catch (error) {
        const transient = error instanceof TypeError || (error instanceof DOMException && error.name === "TimeoutError") || (error instanceof GoogleCalendarError && ([408, 502, 503, 504].includes(error.status) || (path === "schedule/availability" && error.status === 429)));
        if ((path === "schedule/availability" && ((typeof navigator !== "undefined" && !navigator.onLine) || (error instanceof GoogleCalendarError && ["calendar_invalid_response", "calendar_unreadable"].includes(error.reasonCode || "")))) || !transient || attempt >= 2 || auth.signal?.aborted || auth.isEffectCurrent?.() === false) throw error;
        await new Promise<void>((resolve, reject) => {
          const abort = () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); };
          const timer = setTimeout(() => { auth.signal?.removeEventListener("abort", abort); resolve(); }, attempt === 0 ? 750 : 2000);
          auth.signal?.addEventListener("abort", abort, { once: true });
        });
      }
    }
  }

  static async today(params: { firebaseIdToken: string; signal?: AbortSignal; isEffectCurrent?: () => boolean; date: string; timeZone: string }): Promise<CalendarDailyResponse> {
    const result = await this.scheduleRead<CalendarDailyResponse>("schedule/today", { date: params.date, time_zone: params.timeZone }, params);
    if (!result || result.date !== params.date || result.time_zone !== params.timeZone || !Array.isArray(result.events) || !Array.isArray(result.calendars) || !result.calendars.length || !Array.isArray(result.unreadable_calendars)) throw new GoogleCalendarError("Calendar events could not be checked.", "calendar_invalid_response", 502);
    return result;
  }

  private static windowBody(params: Omit<CalendarWindowParams, "vaultOwnerToken">) {
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
    const result = await this.scheduleRead<CalendarAvailability>("schedule/availability", { ...this.windowBody({ ...params, startTime: "00:00", endTime: "24:00" }), ...(params.calendarOverrides && Object.keys(params.calendarOverrides).length ? { calendar_overrides: params.calendarOverrides } : {}) }, params);
    if (!result || !this.isFullLocalDay(result, params.date, params.timeZone) || result.date !== params.date || result.time_zone !== params.timeZone || !Array.isArray(result.windows) || result.windows.length > 3 || !Number.isInteger(result.full_count) || result.full_count < result.windows.length || result.requested_duration_minutes !== params.durationMinutes || !Array.isArray(result.calendars) || !result.calendars.length || result.windows.some(window => !Number.isFinite(Date.parse(window.start_at)) || !Number.isFinite(Date.parse(window.end_at)) || Date.parse(window.end_at) <= Date.parse(window.start_at) || Date.parse(window.start_at) < Date.parse(result.time_min) || Date.parse(window.end_at) > Date.parse(result.time_max) || window.duration_minutes < params.durationMinutes || Math.floor((Date.parse(window.end_at) - Date.parse(window.start_at)) / 60000) !== window.duration_minutes)) throw new GoogleCalendarError("Availability could not be checked.", "calendar_invalid_response", 502);
    return result;
  }

  static reviewAttendance(params: CalendarWindowParams & { firebaseIdToken: string; signal?: AbortSignal; isEffectCurrent?: () => boolean; eventId: string; calendarId?: string; offerTimes: boolean; message: string }): Promise<CalendarAttendanceReview> {
    return this.scheduleRequest("attendance/review", params.vaultOwnerToken, { ...this.windowBody(params), event_id: params.eventId, calendar_id: params.calendarId || "primary", offer_times: params.offerTimes, message: params.message }, params);
  }

  static confirmAttendance(params: { firebaseIdToken: string; signal?: AbortSignal; isEffectCurrent?: () => boolean; vaultOwnerToken: string; reviewId: string; reviewToken: string }): Promise<CalendarAttendanceResult> {
    return this.scheduleRequest("attendance/confirm", params.vaultOwnerToken, { review_id: params.reviewId, review_token: params.reviewToken }, params);
  }

  static publicReschedulingOptions(token: string): Promise<{ openings: CalendarOpening[]; time_zone: string; reply_to: string; event_link?: string }> {
    return this.scheduleRequest("rescheduling/options", null, { token });
  }

}
