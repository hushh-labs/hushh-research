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

export type GmailNativePurpose = GmailNativeConnectStartResponse["purpose"];

/** Preserve only the owner's recorded grants while keeping first connection read-only. */
export function planGmailNativeConnect(requested: GmailNativePurpose, status: {
  scope_csv?: string | null;
  send_permission_granted?: boolean;
  compose_permission_granted?: boolean;
  modify_permission_granted?: boolean;
}) {
  const scopes = new Set((status.scope_csv ?? "").split(/[\s,]+/));
  const granted = (scope: string, flag: boolean | undefined) =>
    flag === true || scopes.has(`https://www.googleapis.com/auth/gmail.${scope}`);
  const send = requested === "send" || granted("send", status.send_permission_granted);
  const compose = requested === "compose" || granted("compose", status.compose_permission_granted);
  return {
    purpose: compose ? "compose" as const : send ? "send" as const : "read" as const,
    preserveSend: send,
    preserveModify: granted("modify", status.modify_permission_granted),
  };
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
    (payload.purpose !== "read" && payload.purpose !== "send" && payload.purpose !== "compose")
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
