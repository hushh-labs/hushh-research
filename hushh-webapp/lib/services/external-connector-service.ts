import { ApiService } from "@/lib/services/api-service";

export type ExternalConnectorAuthStyle = "api_key" | "oauth";

export type ExternalConnectorStatus =
  | "not_connected"
  | "connected"
  | "revoked"
  | "error";

export type ExternalConnectorSummary = {
  connectorId: string;
  displayName: string;
  description: string;
  authStyle: ExternalConnectorAuthStyle;
  status: ExternalConnectorStatus;
  accountLabel?: string | null;
  connectedAt?: string | null;
};

function authHeaders(vaultOwnerToken: string): HeadersInit {
  return ApiService.getAuthHeaders(vaultOwnerToken);
}

async function readJsonOrThrow<T>(response: Response): Promise<T> {
  const payload = (await response.json().catch(() => null)) as unknown;
  if (response.ok) {
    return payload as T;
  }
  const record =
    payload && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {};
  const detail =
    record.detail && typeof record.detail === "object"
      ? (record.detail as Record<string, unknown>)
      : record;
  const message =
    typeof detail.message === "string"
      ? detail.message
      : typeof record.detail === "string"
        ? record.detail
        : null;
  throw new Error(message || `Request failed (${response.status}).`);
}

/** Typed transport for /api/connectors. Components never call fetch directly. */
export class ExternalConnectorService {
  static async list(
    vaultOwnerToken: string,
  ): Promise<ExternalConnectorSummary[]> {
    const response = await ApiService.apiFetch("/api/connectors", {
      method: "GET",
      headers: authHeaders(vaultOwnerToken),
    });
    const payload = await readJsonOrThrow<{
      connectors?: ExternalConnectorSummary[];
    }>(response);
    return Array.isArray(payload.connectors) ? payload.connectors : [];
  }

  static async connectWithApiKey(input: {
    vaultOwnerToken: string;
    connectorId: string;
    apiKey: string;
    accountLabel?: string;
  }): Promise<{ status: string; connectorId: string }> {
    const response = await ApiService.apiFetch(
      `/api/connectors/${encodeURIComponent(input.connectorId)}/connect/api-key`,
      {
        method: "POST",
        headers: {
          ...authHeaders(input.vaultOwnerToken),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          apiKey: input.apiKey,
          accountLabel: input.accountLabel ?? null,
        }),
      },
    );
    return readJsonOrThrow(response);
  }

  static async startOAuthConnect(input: {
    vaultOwnerToken: string;
    connectorId: string;
    redirectUri: string;
  }): Promise<{ authorizeUrl: string; expiresAt: string }> {
    const response = await ApiService.apiFetch(
      `/api/connectors/${encodeURIComponent(input.connectorId)}/connect/oauth/start`,
      {
        method: "POST",
        headers: {
          ...authHeaders(input.vaultOwnerToken),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ redirectUri: input.redirectUri }),
      },
    );
    return readJsonOrThrow(response);
  }

  static async completeOAuthConnect(input: {
    vaultOwnerToken: string;
    state: string;
    code: string;
  }): Promise<{ status: string; connectorId: string }> {
    const response = await ApiService.apiFetch("/api/connectors/oauth/complete", {
      method: "POST",
      headers: {
        ...authHeaders(input.vaultOwnerToken),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ state: input.state, code: input.code }),
    });
    return readJsonOrThrow(response);
  }

  static async disconnect(input: {
    vaultOwnerToken: string;
    connectorId: string;
  }): Promise<{ status: string; connectorId: string }> {
    const response = await ApiService.apiFetch(
      `/api/connectors/${encodeURIComponent(input.connectorId)}/disconnect`,
      {
        method: "POST",
        headers: authHeaders(input.vaultOwnerToken),
      },
    );
    return readJsonOrThrow(response);
  }
}
