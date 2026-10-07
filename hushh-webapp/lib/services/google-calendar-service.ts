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
  conference_url?: string | null;
  conference_status?: string | null;
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
    await requireSharedGoogleExchange();
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
      throw new Error(
        await errorMessage(response, "Unable to finish Calendar connection."),
      );
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
      throw new Error(
        await errorMessage(response, "Unable to load Calendar events."),
      );
    return response.json() as Promise<CalendarEventsResponse>;
  }
}
