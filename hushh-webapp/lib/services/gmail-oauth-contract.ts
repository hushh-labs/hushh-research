/** OAuth start payload contracts, independent of transport and owner state. */
export interface GmailConnectStartResponse {
  configured: boolean;
  authorize_url: string;
  state: string;
  redirect_uri: string;
  expires_at: string;
}

export interface GmailNativeConnectStartResponse {
  configured: boolean;
  server_client_id: string;
  purpose: "read" | "send" | "compose";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseGmailNativeConnectStartPayload(
  payload: unknown,
): GmailNativeConnectStartResponse {
  if (
    !isRecord(payload) ||
    typeof payload.configured !== "boolean" ||
    typeof payload.server_client_id !== "string" ||
    payload.server_client_id.trim().length === 0 ||
    (payload.purpose !== "read" && payload.purpose !== "send")
  ) {
    throw new Error("Mail OAuth start returned an invalid response.");
  }
  return payload as unknown as GmailNativeConnectStartResponse;
}

export function parseGmailConnectStartPayload(
  payload: unknown,
): GmailConnectStartResponse {
  if (
    !isRecord(payload) ||
    typeof payload.configured !== "boolean" ||
    typeof payload.authorize_url !== "string" ||
    payload.authorize_url.trim().length === 0 ||
    typeof payload.state !== "string" ||
    payload.state.trim().length === 0 ||
    typeof payload.redirect_uri !== "string" ||
    typeof payload.expires_at !== "string" ||
    payload.expires_at.trim().length === 0
  ) {
    throw new Error("Mail OAuth start returned an invalid response.");
  }
  return payload as unknown as GmailConnectStartResponse;
}
