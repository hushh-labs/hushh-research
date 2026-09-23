import { BACKEND_URL } from "@/lib/config";
import { ApiService } from "@/lib/services/api-service";

export type ExternalConnectorAuthStyle = "api_key" | "oauth";

export type ExternalConnectorStatus =
  | "not_connected"
  | "connected"
  | "verifying"
  | "needs_reauth"
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
  validationState?: string;
  revocationOutcome?: string;
  lastErrorCode?: string | null;
  available?: boolean;
};

export type ConnectorFeatures = Partial<
  Record<
    | "connections_panel_v2"
    | "google_drive_connection"
    | "google_drive_picker"
    | "drive_document_indexing"
    | "drive_document_sharing"
    | "gmail_chat_reads"
    | "google_drive_chat_reads",
    boolean
  >
>;
export type ConnectorOverview = {
  connectors: ExternalConnectorSummary[];
  features: ConnectorFeatures;
};
export type DriveDocument = {
  documentId: string;
  name: string;
  mimeType: string;
  status: string;
  backgroundProcessing?: boolean;
};

export type NativeDriveOAuthOutcome = "ready" | "cancelled" | "failed";

export type NativeDriveOAuthReturn = {
  attemptId: string;
  outcome: NativeDriveOAuthOutcome;
};

export type PendingNativeDriveAttempt = {
  attemptId: string;
  expiresAt: string;
};

/**
 * Metadata returned only after the native Picker browser flow has settled at
 * the server.  These are candidates, not selected One documents: the owner
 * must still explicitly confirm them through the owner-protected endpoint.
 */
export type NativeDrivePickerCandidate = {
  documentId: string;
  name: string;
  mimeType: string;
};

export type PendingNativeDrivePicker = {
  attemptId: string;
  expiresAt: string;
  files: NativeDrivePickerCandidate[];
};

export type ConnectorEffectGuard = () => boolean;
/** Never persist this response, put it in React state, or send it through messages. */
export type DrivePickerSession = {
  sessionId: string;
  expiresAt: string;
  accessToken: string;
  tokenExpiresAt: string;
  developerKey: string;
  appId: string;
  origin: string;
};

function authHeaders(vaultOwnerToken: string): HeadersInit {
  return ApiService.getAuthHeaders(vaultOwnerToken);
}

/**
 * Native Google OAuth must return to the registered HTTPS backend callback.
 * It must never use the Capacitor origin or the web proxy, which would follow
 * the backend's custom-scheme handoff and turn it into a JSON response.
 */
export function nativeDriveOAuthCallbackUri(): string {
  let backend: URL;
  try {
    backend = new URL(BACKEND_URL);
  } catch {
    throw new Error("Native Drive connection is unavailable in this build.");
  }
  if (
    backend.protocol !== "https:" ||
    backend.username ||
    backend.password ||
    backend.pathname !== "/" ||
    backend.search ||
    backend.hash
  ) {
    throw new Error("Native Drive connection is unavailable in this build.");
  }
  return new URL("/api/connectors/oauth/native/callback", backend).toString();
}

/**
 * Unlike a web Picker session, the native flow never sends an access token to
 * JavaScript. The HTTPS callback stages only server-verified candidate
 * metadata, then hands the app an opaque custom-scheme result.
 */
export function nativeDrivePickerCallbackUri(): string {
  let backend: URL;
  try {
    backend = new URL(BACKEND_URL);
  } catch {
    throw new Error("Native Drive file selection is unavailable in this build.");
  }
  if (
    backend.protocol !== "https:" ||
    backend.username ||
    backend.password ||
    backend.pathname !== "/" ||
    backend.search ||
    backend.hash
  ) {
    throw new Error("Native Drive file selection is unavailable in this build.");
  }
  return new URL(
    "/api/connectors/google_drive/picker/native/callback",
    backend,
  ).toString();
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
  static nativeDriveOAuthCallbackUri(): string {
    return nativeDriveOAuthCallbackUri();
  }

  static nativeDrivePickerCallbackUri(): string {
    return nativeDrivePickerCallbackUri();
  }

  static async list(
    vaultOwnerToken: string,
  ): Promise<ExternalConnectorSummary[]> {
    return (await this.overview(vaultOwnerToken)).connectors;
  }

  static async overview(vaultOwnerToken: string): Promise<ConnectorOverview> {
    const response = await ApiService.apiFetch("/api/connectors", {
      method: "GET",
      headers: authHeaders(vaultOwnerToken),
    });
    const payload = await readJsonOrThrow<{
      connectors?: ExternalConnectorSummary[];
      features?: ConnectorFeatures;
    }>(response);
    return {
      connectors: Array.isArray(payload.connectors) ? payload.connectors : [],
      features: payload.features ?? {},
    };
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
    flow?: "web" | "native";
    isEffectCurrent?: ConnectorEffectGuard;
  }): Promise<{
    authorizeUrl: string;
    expiresAt: string;
    attemptId?: string;
    connectorId?: string;
  }> {
    const response = await ApiService.apiFetch(
      `/api/connectors/${encodeURIComponent(input.connectorId)}/connect/oauth/start`,
      {
        method: "POST",
        headers: {
          ...authHeaders(input.vaultOwnerToken),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          redirectUri: input.redirectUri,
          flow: input.flow ?? "web",
        }),
        isEffectCurrent: input.isEffectCurrent,
      },
    );
    return readJsonOrThrow(response);
  }

  static async pendingNative(input: {
    vaultOwnerToken: string;
    isEffectCurrent?: ConnectorEffectGuard;
  }): Promise<PendingNativeDriveAttempt | null> {
    const response = await ApiService.apiFetch(
      "/api/connectors/oauth/native/pending",
      {
        method: "GET",
        cache: "no-store",
        headers: authHeaders(input.vaultOwnerToken),
        isEffectCurrent: input.isEffectCurrent,
      },
    );
    const payload = await readJsonOrThrow<{
      pending?: PendingNativeDriveAttempt | null;
    }>(response);
    return payload.pending ?? null;
  }

  static async finalizeNative(input: {
    vaultOwnerToken: string;
    attemptId: string;
    isEffectCurrent?: ConnectorEffectGuard;
  }): Promise<{ status: string; connectorId: string }> {
    return readJsonOrThrow(
      await ApiService.apiFetch("/api/connectors/oauth/native/finalize", {
        method: "POST",
        headers: {
          ...authHeaders(input.vaultOwnerToken),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ attemptId: input.attemptId }),
        isEffectCurrent: input.isEffectCurrent,
      }),
    );
  }

  static async startNativePicker(input: {
    vaultOwnerToken: string;
    redirectUri: string;
    isEffectCurrent?: ConnectorEffectGuard;
  }): Promise<{
    authorizeUrl: string;
    expiresAt: string;
    attemptId: string;
  }> {
    return readJsonOrThrow(
      await ApiService.apiFetch(
        "/api/connectors/google_drive/picker/native/start",
        {
          method: "POST",
          headers: {
            ...authHeaders(input.vaultOwnerToken),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ redirectUri: input.redirectUri }),
          isEffectCurrent: input.isEffectCurrent,
        },
      ),
    );
  }

  static async pendingNativePicker(input: {
    vaultOwnerToken: string;
    isEffectCurrent?: ConnectorEffectGuard;
  }): Promise<PendingNativeDrivePicker | null> {
    const payload = await readJsonOrThrow<{
      pending?: PendingNativeDrivePicker | null;
    }>(
      await ApiService.apiFetch(
        "/api/connectors/google_drive/picker/native/pending",
        {
          method: "GET",
          cache: "no-store",
          headers: authHeaders(input.vaultOwnerToken),
          isEffectCurrent: input.isEffectCurrent,
        },
      ),
    );
    return payload.pending ?? null;
  }

  static async confirmNativePicker(input: {
    vaultOwnerToken: string;
    attemptId: string;
    backgroundProcessing?: boolean;
    isEffectCurrent?: ConnectorEffectGuard;
  }): Promise<{ documents: DriveDocument[] }> {
    return readJsonOrThrow(
      await ApiService.apiFetch(
        "/api/connectors/google_drive/picker/native/confirm",
        {
          method: "POST",
          headers: {
            ...authHeaders(input.vaultOwnerToken),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            attemptId: input.attemptId,
            ...(input.backgroundProcessing
              ? { processingConsent: "selected-files-background-v1" }
              : {}),
          }),
          isEffectCurrent: input.isEffectCurrent,
        },
      ),
    );
  }

  static async cancelNativePicker(input: {
    vaultOwnerToken: string;
    attemptId: string;
    isEffectCurrent?: ConnectorEffectGuard;
  }): Promise<void> {
    await readJsonOrThrow(
      await ApiService.apiFetch(
        "/api/connectors/google_drive/picker/native/cancel",
        {
          method: "POST",
          headers: {
            ...authHeaders(input.vaultOwnerToken),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ attemptId: input.attemptId }),
          isEffectCurrent: input.isEffectCurrent,
        },
      ),
    );
  }

  static async completeOAuthConnect(input: {
    vaultOwnerToken: string;
    state: string;
    code: string;
  }): Promise<{ status: string; connectorId: string }> {
    const response = await ApiService.apiFetch(
      "/api/connectors/oauth/complete",
      {
        method: "POST",
        headers: {
          ...authHeaders(input.vaultOwnerToken),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ state: input.state, code: input.code }),
      },
    );
    return readJsonOrThrow(response);
  }

  static async disconnect(input: {
    vaultOwnerToken: string;
    connectorId: string;
  }): Promise<{
    status: string;
    connectorId: string;
    revocationOutcome?: string;
  }> {
    const response = await ApiService.apiFetch(
      `/api/connectors/${encodeURIComponent(input.connectorId)}/disconnect`,
      {
        method: "POST",
        headers: authHeaders(input.vaultOwnerToken),
      },
    );
    return readJsonOrThrow(response);
  }

  static async completeWebOAuth(input: {
    idToken: string;
    state: string;
    code: string;
    attemptId: string;
  }): Promise<{ status: string; connectorId: string }> {
    return readJsonOrThrow(
      await ApiService.apiFetch("/api/connectors/oauth/complete/web", {
        method: "POST",
        headers: {
          ...authHeaders(input.idToken),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          state: input.state,
          code: input.code,
          attemptId: input.attemptId,
        }),
      }),
    );
  }

  static async pickerSession(
    vaultOwnerToken: string,
    origin: string,
  ): Promise<DrivePickerSession> {
    return readJsonOrThrow(
      await ApiService.apiFetch("/api/connectors/google_drive/picker/session", {
        method: "POST",
        headers: {
          ...authHeaders(vaultOwnerToken),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ origin }),
      }),
    );
  }

  static async selectDocuments(
    vaultOwnerToken: string,
    sessionId: string,
    fileIds: string[],
    backgroundProcessing = false,
  ): Promise<DriveDocument[]> {
    const result = await readJsonOrThrow<{ documents: DriveDocument[] }>(
      await ApiService.apiFetch(
        "/api/connectors/google_drive/documents/select",
        {
          method: "POST",
          headers: {
            ...authHeaders(vaultOwnerToken),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            sessionId,
            fileIds,
            confirmed: true,
            ...(backgroundProcessing
              ? { processingConsent: "selected-files-background-v1" }
              : {}),
          }),
        },
      ),
    );
    return result.documents;
  }

  static async documents(vaultOwnerToken: string): Promise<DriveDocument[]> {
    const result = await readJsonOrThrow<{ documents: DriveDocument[] }>(
      await ApiService.apiFetch("/api/connectors/google_drive/documents", {
        method: "GET",
        headers: authHeaders(vaultOwnerToken),
      }),
    );
    return result.documents;
  }

  static async removeDocument(
    vaultOwnerToken: string,
    documentId: string,
  ): Promise<void> {
    await readJsonOrThrow(
      await ApiService.apiFetch(
        `/api/connectors/google_drive/documents/${encodeURIComponent(documentId)}`,
        {
          method: "DELETE",
          headers: {
            ...authHeaders(vaultOwnerToken),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ confirmed: true }),
        },
      ),
    );
  }

  static async setDocumentProcessing(
    vaultOwnerToken: string,
    documentId: string,
    enabled: boolean,
  ): Promise<void> {
    await readJsonOrThrow(
      await ApiService.apiFetch(
        `/api/connectors/google_drive/documents/${encodeURIComponent(documentId)}/processing`,
        {
          method: "POST",
          headers: {
            ...authHeaders(vaultOwnerToken),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            enabled,
            confirmed: true,
            ...(enabled ? { disclosure: "selected-files-background-v1" } : {}),
          }),
        },
      ),
    );
  }

  static async syncDocument(
    vaultOwnerToken: string,
    documentId: string,
  ): Promise<void> {
    await readJsonOrThrow(
      await ApiService.apiFetch(
        `/api/connectors/google_drive/documents/${encodeURIComponent(documentId)}/sync`,
        { method: "POST", headers: authHeaders(vaultOwnerToken) },
      ),
    );
  }
}
