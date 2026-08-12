import { ApiService } from "@/lib/services/api-service";

export type GoogleCalendarStatus = {
  configured: boolean;
  connected: boolean;
  google_email?: string | null;
  status: "connected" | "needs_reauth" | "disconnected";
  access_level?: "read" | "manage" | null;
  scope_csv: string;
};

type OAuthStart = { authorize_url: string; redirect_uri: string; expires_at: string };

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

async function errorMessage(response: Response, fallback: string): Promise<string> {
  const body = await response.json().catch(() => null) as { detail?: { message?: string } | string } | null;
  const detail = body?.detail;
  return (typeof detail === "string" ? detail : detail?.message) || fallback;
}

/** Typed transport for the Calendar API. Components never call fetch directly. */
export class GoogleCalendarService {
  static async status(idToken: string, userId: string): Promise<GoogleCalendarStatus> {
    const response = await ApiService.apiFetch(`/api/one/calendar/status/${encodeURIComponent(userId)}`, {
      headers: { Authorization: `Bearer ${idToken}` },
    });
    if (!response.ok) throw new Error(await errorMessage(response, "Unable to load Calendar connection."));
    return response.json() as Promise<GoogleCalendarStatus>;
  }

  static async startConnect(params: { idToken: string; userId: string; accessLevel: "read" | "manage" }): Promise<OAuthStart> {
    const response = await ApiService.apiFetch("/api/one/calendar/connect/start", {
      method: "POST", headers: { Authorization: `Bearer ${params.idToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: params.userId, access_level: params.accessLevel }),
    });
    if (!response.ok) throw new Error(await errorMessage(response, "Unable to start Calendar connection."));
    return response.json() as Promise<OAuthStart>;
  }

  static async completeConnect(params: { idToken: string; userId: string; code: string; state: string }): Promise<GoogleCalendarStatus> {
    const response = await ApiService.apiFetch("/api/one/calendar/connect/complete", {
      method: "POST", headers: { Authorization: `Bearer ${params.idToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: params.userId, code: params.code, state: params.state }),
    });
    if (!response.ok) throw new Error(await errorMessage(response, "Unable to finish Calendar connection."));
    return response.json() as Promise<GoogleCalendarStatus>;
  }

  static async disconnect(idToken: string, userId: string): Promise<GoogleCalendarStatus> {
    const response = await ApiService.apiFetch("/api/one/calendar/disconnect", {
      method: "POST", headers: { Authorization: `Bearer ${idToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ user_id: userId }),
    });
    if (!response.ok) throw new Error(await errorMessage(response, "Unable to disconnect Calendar."));
    return response.json() as Promise<GoogleCalendarStatus>;
  }

  /** Execute one short-lived Calendar proposal after an owner confirms it in chat. */
  static async executeProposal(params: {
    vaultOwnerToken: string;
    userId: string;
    proposalId: string;
  }): Promise<CalendarExecution> {
    const response = await ApiService.apiFetch("/api/one/calendar/proposals/execute", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${params.vaultOwnerToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ user_id: params.userId, proposal_id: params.proposalId }),
    });
    if (!response.ok) throw new Error(await errorMessage(response, "Unable to apply Calendar change."));
    return response.json() as Promise<CalendarExecution>;
  }
}
