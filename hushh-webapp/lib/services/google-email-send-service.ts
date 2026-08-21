import { ApiService } from "@/lib/services/api-service";

export type GoogleEmailSendStatus = {
  configured: boolean;
  connected: boolean;
  google_email?: string | null;
  status: "connected" | "needs_reauth" | "disconnected";
  access_level?: "read" | "send" | "manage" | null;
  scope_csv: string;
};

export type EmailDraft = { to: string[]; cc: string[]; bcc: string[]; subject: string; body: string };
type OAuthStart = { authorize_url: string; redirect_uri: string; expires_at: string };

async function errorMessage(response: Response, fallback: string): Promise<string> {
  const body = await response.json().catch(() => null) as { detail?: { message?: string } | string } | null;
  const detail = body?.detail;
  return (typeof detail === "string" ? detail : detail?.message) || fallback;
}

/** Transport for the owner-confirmed Gmail send boundary. Draft text is never cached here. */
export class GoogleEmailSendService {
  static async status(idToken: string, userId: string): Promise<GoogleEmailSendStatus> {
    const response = await ApiService.apiFetch(`/api/one/email-send/status/${encodeURIComponent(userId)}`, { headers: { Authorization: `Bearer ${idToken}` } });
    if (!response.ok) throw new Error(await errorMessage(response, "Unable to load email sending access."));
    return response.json() as Promise<GoogleEmailSendStatus>;
  }

  static async startConnect(params: { idToken: string; userId: string; loginHint?: string | null }): Promise<OAuthStart> {
    const response = await ApiService.apiFetch("/api/one/email-send/connect/start", {
      method: "POST", headers: { Authorization: `Bearer ${params.idToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: params.userId, login_hint: params.loginHint || null }),
    });
    if (!response.ok) throw new Error(await errorMessage(response, "Unable to request Gmail sending access."));
    return response.json() as Promise<OAuthStart>;
  }

  static async completeConnect(params: { idToken: string; userId: string; code: string; state: string }): Promise<GoogleEmailSendStatus> {
    const response = await ApiService.apiFetch("/api/one/email-send/connect/complete", {
      method: "POST", headers: { Authorization: `Bearer ${params.idToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: params.userId, code: params.code, state: params.state }),
    });
    if (!response.ok) throw new Error(await errorMessage(response, "Unable to finish Gmail sending setup."));
    return response.json() as Promise<GoogleEmailSendStatus>;
  }

  static async prepare(params: { vaultOwnerToken: string; userId: string; draft: EmailDraft; idempotencyKey: string }): Promise<{ action_id: string; expires_at: string }> {
    const response = await ApiService.apiFetch("/api/one/email-send/prepare", {
      method: "POST", headers: { Authorization: `Bearer ${params.vaultOwnerToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: params.userId, draft: params.draft, idempotency_key: params.idempotencyKey }),
    });
    if (!response.ok) throw new Error(await errorMessage(response, "Unable to prepare this email."));
    return response.json() as Promise<{ action_id: string; expires_at: string }>;
  }

  static async draft(params: { vaultOwnerToken: string; userId: string; instruction: string }): Promise<EmailDraft & { missing_details: string[] }> {
    const response = await ApiService.apiFetch("/api/one/email-send/draft", {
      method: "POST", headers: { Authorization: `Bearer ${params.vaultOwnerToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: params.userId, instruction: params.instruction }),
    });
    if (!response.ok) throw new Error(await errorMessage(response, "One could not draft that email."));
    return response.json() as Promise<EmailDraft & { missing_details: string[] }>;
  }

  static async execute(params: { vaultOwnerToken: string; userId: string; actionId: string; draft: EmailDraft }): Promise<{ status: "sent"; message_id: string; thread_id?: string | null }> {
    const response = await ApiService.apiFetch("/api/one/email-send/execute", {
      method: "POST", headers: { Authorization: `Bearer ${params.vaultOwnerToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: params.userId, action_id: params.actionId, draft: params.draft }),
    });
    if (!response.ok) throw new Error(await errorMessage(response, "Gmail could not send this email."));
    return response.json() as Promise<{ status: "sent"; message_id: string; thread_id?: string | null }>;
  }
}
