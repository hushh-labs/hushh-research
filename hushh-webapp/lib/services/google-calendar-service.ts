import { ApiService } from "@/lib/services/api-service";

export type GoogleCalendarStatus = {
  configured: boolean;
  connected: boolean;
  google_email?: string | null;
  status: "connected" | "needs_reauth" | "disconnected";
  access_level?: "read" | "manage" | null;
  scope_csv: string;
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
};

export type CalendarExecution = {
  action: "create" | "reschedule" | "cancel";
  event: {
    id?: string | null;
    title?: string | null;
    start?: { dateTime?: string; date?: string } | null;
    end?: { dateTime?: string; date?: string } | null;
    status?: string | null;
  };
};

export type CalendarEventTime = { dateTime?: string; date?: string } | null;

/**
 * The RAW backend event shape (matches _event_summary() in
 * hushh_mcp/services/google_calendar_service.py exactly, including
 * description/location/attendees). listEvents() below returns this
 * unredacted on purpose -- redaction is lib/calendar/use-calendar-upcoming-events.ts's
 * job, never this service's. Do not render this type directly.
 */
export type CalendarEventSummary = {
  id?: string | null;
  etag?: string | null;
  title: string;
  description?: string | null;
  location?: string | null;
  start: CalendarEventTime;
  end: CalendarEventTime;
  status?: string | null;
  attendees?: { email?: string | null; response_status?: string | null }[];
  html_link?: string | null;
  updated?: string | null;
};

export type CalendarEventsResponse = {
  events: CalendarEventSummary[];
  time_zone?: string | null;
};

async function errorMessage(
  response: Response,
  fallback: string,
): Promise<string> {
  const body = (await response.json().catch(() => null)) as {
    detail?: { message?: string } | string;
  } | null;
  const detail = body?.detail;
  return (typeof detail === "string" ? detail : detail?.message) || fallback;
}

/** Typed transport for the Calendar API. Components never call fetch directly. */
export class GoogleCalendarService {
  static async status(
    idToken: string,
    userId: string,
  ): Promise<GoogleCalendarStatus> {
    const response = await ApiService.apiFetch(
      `/api/one/calendar/status/${encodeURIComponent(userId)}`,
      {
        headers: { Authorization: `Bearer ${idToken}` },
      },
    );
    if (!response.ok)
      throw new Error(
        await errorMessage(response, "Unable to load Calendar connection."),
      );
    return response.json() as Promise<GoogleCalendarStatus>;
  }

  static async startConnect(params: {
    idToken: string;
    userId: string;
    accessLevel: "read" | "manage";
  }): Promise<OAuthStart> {
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
        }),
      },
    );
    if (!response.ok)
      throw new Error(
        await errorMessage(response, "Unable to start Calendar connection."),
      );
    return response.json() as Promise<OAuthStart>;
  }

  static async completeConnect(params: {
    idToken: string;
    userId: string;
    code: string;
    state: string;
  }): Promise<GoogleCalendarStatus> {
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
        }),
      },
    );
    if (!response.ok)
      throw new Error(
        await errorMessage(response, "Unable to finish Calendar connection."),
      );
    return response.json() as Promise<GoogleCalendarStatus>;
  }

  static async startNativeConnect(params: {
    idToken: string;
    accessLevel: "read" | "manage";
  }): Promise<NativeOAuthStart> {
    const response = await ApiService.apiFetch(
      "/api/one/calendar/connect/native/start",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${params.idToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ access_level: params.accessLevel }),
      },
    );
    if (!response.ok)
      throw new Error(
        await errorMessage(response, "Unable to start Calendar connection."),
      );
    return response.json() as Promise<NativeOAuthStart>;
  }

  static async completeNativeConnect(params: {
    idToken: string;
    userId: string;
    accessLevel: "read" | "manage";
    serverAuthCode: string;
  }): Promise<GoogleCalendarStatus> {
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
        }),
      },
    );
    if (!response.ok)
      throw new Error(
        await errorMessage(response, "Unable to finish Calendar connection."),
      );
    return response.json() as Promise<GoogleCalendarStatus>;
  }

  static async disconnect(
    idToken: string,
    userId: string,
  ): Promise<GoogleCalendarStatus> {
    const response = await ApiService.apiFetch("/api/one/calendar/disconnect", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${idToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ user_id: userId }),
    });
    if (!response.ok)
      throw new Error(
        await errorMessage(response, "Unable to disconnect Calendar."),
      );
    return response.json() as Promise<GoogleCalendarStatus>;
  }

  /** Execute one short-lived Calendar proposal after an owner confirms it in chat. */
  static async executeProposal(params: {
    vaultOwnerToken: string;
    userId: string;
    proposalId: string;
  }): Promise<CalendarExecution> {
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
      throw new Error(
        await errorMessage(response, "Unable to apply Calendar change."),
      );
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
      throw new Error(
        await errorMessage(response, "Unable to load Calendar events."),
      );
    return response.json() as Promise<CalendarEventsResponse>;
  }
}
