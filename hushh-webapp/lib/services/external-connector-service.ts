import { BACKEND_URL } from "@/lib/config";
import { ApiService } from "@/lib/services/api-service";
import {
  projectCustomConnectorTurnConfigurations,
  type CustomConnectorConfiguration,
} from "@/lib/connections/custom-connector-schema";
import {
  parseMcpCallApproval, parseMcpCallPreview,
  type McpCallApproval, type McpCallPreview, type McpCallReviewReference,
} from "@/lib/agent/mcp-call-review";
import { ONE_CHAT_KEY_HEADER } from "@/lib/vault/one-chat-key";
import { observeServerDate, serverNow } from "@/lib/agent/server-clock";

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
  profile?: "selected" | "live" | null;
  revocationOutcome?: string;
  lastErrorCode?: string | null;
  available?: boolean;
  /** Server-derived: an operator-registered OAuth provider with a reviewed manifest. */
  curatedOAuth?: boolean;
  /** Server-derived first-party OAuth adapter backed by the connector lifecycle. */
  managedOAuth?: boolean;
  /** Server-declared built-in card; presentation only and never an OAuth grant. */
  catalogCard?: boolean;
  /** Why a server-declared catalog card cannot yet start a connection. */
  catalogState?: "setup_pending" | "discovery_pending" | "unavailable" | null;
};

export type ConnectorFeatures = Partial<
  Record<
    | "connections_panel_v2"
    | "google_drive_connection"
    | "google_drive_live"
    | "google_drive_picker"
    | "drive_document_indexing"
    | "drive_document_sharing"
    | "gmail_chat_reads"
    | "google_drive_chat_reads"
    | "curated_mcp_connectors",
    boolean
  >
>;
export type ConnectorOverview = {
  connectors: ExternalConnectorSummary[];
  features: ConnectorFeatures;
};

export type InstagramOwnedPost = {
  id: string;
  caption: string;
  mediaType: string;
  permalink: string;
  timestamp: string;
  mediaUrl: string | null;
  thumbnailUrl: string | null;
};

export type InstagramOwnedMediaPage = {
  posts: InstagramOwnedPost[];
  nextCursor: string | null;
};

export type InstagramComment = {
  id: string;
  text: string;
  timestamp: string;
  username: string;
  hidden: boolean;
};
export type InstagramCommentsPage = {
  comments: InstagramComment[];
  nextCursor: string | null;
};
export type InstagramInsight = {
  metric: string;
  available: boolean;
  value: number | null;
};
export type InstagramTaggedMedia = {
  id: string;
  username: string;
  permalink: string;
  timestamp: string;
};
export type InstagramTaggedMediaPage = {
  media: InstagramTaggedMedia[];
  nextCursor: string | null;
};
export type InstagramMessage = {
  id: string;
  senderId: string;
  createdTime: string;
  text: string;
};
export type InstagramMessages = { messages: InstagramMessage[] };

export const INSTAGRAM_ACCOUNT_METRICS = [
  "reach", "views", "accounts_engaged", "total_interactions", "profile_links_taps",
] as const;
export const INSTAGRAM_MEDIA_METRICS = [
  "reach", "views", "likes", "comments", "saved", "shares", "total_interactions",
  "ig_reels_avg_watch_time", "ig_reels_video_view_total_time",
] as const;
export type InstagramAccountMetric = typeof INSTAGRAM_ACCOUNT_METRICS[number];
export type InstagramMediaMetric = typeof INSTAGRAM_MEDIA_METRICS[number];

const INSTAGRAM_NUMERIC_ID = /^[0-9]{1,32}$/;
const INSTAGRAM_CURSOR = /^[A-Za-z0-9_-]{1,512}$/;
const INSTAGRAM_OPAQUE_ID = /^[A-Za-z0-9_-]{1,512}$/;

export function validInstagramNumericId(value: unknown): value is string {
  return typeof value === "string" && INSTAGRAM_NUMERIC_ID.test(value);
}

function validInstagramOpaqueId(value: unknown): value is string {
  return typeof value === "string" && INSTAGRAM_OPAQUE_ID.test(value);
}

function validInstagramPermalink(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048 || /[\u0000-\u0020\u007f-\u009f\\]/.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      (url.hostname === "instagram.com" || url.hostname === "www.instagram.com") &&
      !url.username && !url.password && !url.port;
  } catch {
    return false;
  }
}

function instagramInsight(value: InstagramInsight, metric: string): InstagramInsight {
  if (value?.metric !== metric || typeof value.available !== "boolean" ||
      (value.available && (typeof value.value !== "number" || !Number.isFinite(value.value) || value.value < 0)) ||
      (!value.available && value.value !== null)) {
    throw new Error("Instagram insight could not be verified.");
  }
  return value;
}

function instagramId(value: string): string {
  if (!validInstagramNumericId(value)) throw new Error("Enter an Instagram numeric ID (up to 32 digits).");
  return value;
}

function instagramCursor(value: string | undefined): string | undefined {
  if (value !== undefined && !INSTAGRAM_CURSOR.test(value)) throw new Error("Instagram page is invalid.");
  return value;
}

function instagramText(value: string, maxLength: number): string {
  if (!value.trim() || value.length > maxLength || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(value)) {
    throw new Error("Enter a valid Instagram message.");
  }
  return value;
}

function instagramPageCursor(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !INSTAGRAM_CURSOR.test(value)) {
    throw new Error("Instagram page could not be verified.");
  }
  return value;
}

/** Strict post URL projection; sharing parameters never reach the provider. */
export function canonicalInstagramPublicPostUrl(value: string): string | null {
  if (typeof value !== "string" || value.length > 2048 || /[\u0000-\u0020\u007f-\u009f\\]/.test(value)) {
    return null;
  }
  const match = /^https:\/\/(?:www\.)?instagram\.com\/(p|reel)\/([A-Za-z0-9_-]{1,64})\/?(?:\?[^#]*)?$/.exec(value);
  return match ? `https://www.instagram.com/${match[1]}/${match[2]}/` : null;
}

const INSTAGRAM_OEMBED_MAX_RESPONSE_BYTES = 128_000;
const INSTAGRAM_OEMBED_MAX_HTML_BYTES = 100_000;

async function readInstagramPublicEmbed(response: Response): Promise<{ html: string }> {
  if (!response.ok || !response.body) throw new Error("Instagram preview is unavailable right now.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let body = "";
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > INSTAGRAM_OEMBED_MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("Instagram preview could not be verified.");
      }
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new Error("Instagram preview could not be verified.");
  }
  const html = payload && typeof payload === "object" && "html" in payload ? payload.html : null;
  if (
    typeof html !== "string" ||
    new TextEncoder().encode(html).byteLength > INSTAGRAM_OEMBED_MAX_HTML_BYTES ||
    !html.trimStart().toLowerCase().startsWith("<blockquote") ||
    !html.includes("instagram-media") ||
    /<\/?(?:script|iframe)\b/i.test(html)
  ) {
    throw new Error("Instagram preview could not be verified.");
  }
  return { html };
}

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

/** A provider credential failed during catalog discovery; never expose its response. */
export class McpCatalogAuthenticationError extends Error {
  constructor() {
    super("Connector sign-in needs attention.");
    this.name = "McpCatalogAuthenticationError";
  }
}
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

/**
 * `fetch()` resolves when headers arrive, so its transport timeout does not
 * cover a response whose JSON body never finishes. Keep OAuth launch bounded:
 * callers must either receive the validated start payload or regain control to
 * close their pre-opened popup. This does not change the server-side PKCE,
 * state, redirect, or owner-authority checks.
 */
export const CONNECTOR_OAUTH_START_TIMEOUT_MS = 30_000;

function oauthStartTimeoutError(): Error {
  return new Error("OAuth sign-in took too long. Check the connection and try again.");
}

async function withOAuthStartDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  callerSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const abortForCaller = () => controller.abort(callerSignal?.reason);
  if (callerSignal) {
    callerSignal.addEventListener("abort", abortForCaller, { once: true });
    if (callerSignal.aborted) abortForCaller();
  }
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(oauthStartTimeoutError());
  }, CONNECTOR_OAUTH_START_TIMEOUT_MS);

  const pending = operation(controller.signal);
  try {
    return await new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        cleanup();
        reject(controller.signal.reason ?? new Error("OAuth sign-in was cancelled."));
      };
      const cleanup = () =>
        controller.signal.removeEventListener("abort", onAbort);
      controller.signal.addEventListener("abort", onAbort, { once: true });
      pending.then(
        (value) => {
          cleanup();
          resolve(value);
        },
        (error: unknown) => {
          cleanup();
          reject(error);
        },
      );
      if (controller.signal.aborted) onAbort();
    });
  } catch (error) {
    if (timedOut) throw oauthStartTimeoutError();
    throw error;
  } finally {
    clearTimeout(timeout);
    callerSignal?.removeEventListener("abort", abortForCaller);
  }
}

/** Typed transport for /api/connectors. Components never call fetch directly. */
export class ExternalConnectorService {
  /** Explicit connection only. Never used as an automatic tool-call retry. */
  static async privateMcpOAuth(input: {
    vaultOwnerToken: string; connectorId: string;
    operation: "begin" | "complete" | "cancel";
    payload: Record<string, unknown>; signal: AbortSignal;
    isEffectCurrent: ConnectorEffectGuard;
  }): Promise<unknown> {
    const current = () => !input.signal.aborted && input.isEffectCurrent();
    if (!/^custom_[a-f0-9]{32}$/.test(input.connectorId) || !current()) throw new Error("Your connection changed.");
    const response = await ApiService.apiFetch(`/api/connectors/${input.connectorId}/mcp/oauth/${input.operation}`, {
      method: "POST", cache: "no-store", signal: input.signal, isEffectCurrent: current,
      headers: { ...authHeaders(input.vaultOwnerToken), "Content-Type": "application/json" },
      body: JSON.stringify(input.payload),
    });
    if (!response.ok || !current()) throw new Error("Connection was not completed. Please connect again.");
    if (response.status === 204) return null;
    const value: unknown = await response.json();
    if (!current()) throw new Error("Your connection changed.");
    return value;
  }

  static async refreshMcpCatalog(input: {
    vaultOwnerToken: string; configuration: CustomConnectorConfiguration;
    signal: AbortSignal; isEffectCurrent: ConnectorEffectGuard;
  }): Promise<Array<{ id: string; name: string; revision: string; fingerprint: string; permission: "ask_first" | "blocked"; review: "required" | "not_required"; access: "read" | "write" }>> {
    const current = () => !input.signal.aborted && input.isEffectCurrent();
    if (!current()) throw new Error("Your vault session changed.");
    const configuration = projectCustomConnectorTurnConfigurations([input.configuration])[0];
    if (!configuration) throw new Error("Enable this connector before refreshing.");
    const response = await ApiService.apiFetch(`/api/connectors/${encodeURIComponent(configuration.connectorId)}/mcp/catalog`, {
      method: "POST", cache: "no-store", signal: input.signal, isEffectCurrent: current,
      headers: { ...authHeaders(input.vaultOwnerToken), "Content-Type": "application/json" },
      body: JSON.stringify({ connectorConfiguration: configuration }),
    });
    if (!current()) throw new Error("Your vault session changed.");
    if (!response.ok) {
      const payload: unknown = await response.json().catch(() => null);
      const detail = payload && typeof payload === "object" && "detail" in payload
        ? payload.detail : null;
      const code = detail && typeof detail === "object" && "code" in detail
        ? detail.code : null;
      if (code === "EXTERNAL_MCP_AUTH_FAILED" || code === "MCP_CREDENTIAL_EXPIRED")
        throw new McpCatalogAuthenticationError();
      throw new Error("Could not refresh tools. Check the connection and try again.");
    }
    const value = await response.json();
    if (!current() || value?.connectorId !== configuration.connectorId || value?.configurationRevision !== configuration.revision ||
        !["available", "empty"].includes(value?.status) || !Array.isArray(value?.tools) || value.tools.length > 500) {
      throw new Error("Connector tools changed. Refresh again.");
    }
    return value.tools.map((tool: Record<string, unknown>) => {
      if (!tool || typeof tool.id !== "string" || !/^mcp_[a-f0-9]{40}$/.test(tool.id) ||
          typeof tool.name !== "string" || tool.name.length > 256 || typeof tool.revision !== "string" ||
          tool.revision.length > 256 || typeof tool.fingerprint !== "string" ||
          !/^[a-f0-9]{64}$/.test(tool.fingerprint) ||
          !["ask_first", "blocked"].includes(String(tool.permission)) ||
          (tool.review !== undefined && !["required", "not_required"].includes(String(tool.review))) ||
          (tool.access !== undefined && !["read", "write"].includes(String(tool.access))))
        throw new Error("Invalid connector tools.");
      // An older server omits `review`; that means every call is reviewed.
      return { id: tool.id, name: tool.name, revision: tool.revision,
        fingerprint: tool.fingerprint as string, permission: tool.permission as "ask_first" | "blocked",
        review: tool.review === "not_required" ? "not_required" : "required",
        // An older server omits `access`; treat every tool as one that may change.
        access: tool.access === "read" ? "read" : "write" };
    });
  }

  /** Fetch exact arguments into the active review only; never cache or log them. */
  static async reviewMcpCall(input: {
    vaultOwnerToken: string;
    /** Derived chat key header value: the review reads the sealed conversation. */
    chatKey: string;
    conversationId: string;
    reference: McpCallReviewReference;
    configuration?: CustomConnectorConfiguration;
    signal: AbortSignal;
    isEffectCurrent: ConnectorEffectGuard;
  }): Promise<McpCallPreview> {
    const payload = await this.mcpReviewRequest(input, "review", {});
    const preview = parseMcpCallPreview(payload, input.reference);
    if (!preview) throw new Error("This connector review changed. Please review it again.");
    return preview;
  }

  /** Explicit tap only. A failed acknowledgement never triggers an automatic retry. */
  static async confirmMcpCall(input: {
    vaultOwnerToken: string;
    chatKey: string;
    conversationId: string;
    reference: McpCallPreview;
    configuration?: CustomConnectorConfiguration;
    signal: AbortSignal;
    isEffectCurrent: ConnectorEffectGuard;
  }): Promise<McpCallApproval> {
    const payload = await this.mcpReviewRequest(input, "confirm", input.reference.arguments);
    const approval = parseMcpCallApproval(payload, input.reference);
    if (!approval) throw new Error("Confirmation could not be verified. No automatic retry was made.");
    return approval;
  }

  private static async mcpReviewRequest(input: {
    vaultOwnerToken: string;
    chatKey: string;
    conversationId: string;
    reference: McpCallReviewReference;
    configuration?: CustomConnectorConfiguration;
    signal: AbortSignal;
    isEffectCurrent: ConnectorEffectGuard;
  }, operation: "review" | "confirm", args: Record<string, unknown>): Promise<unknown> {
    const current = () => !input.signal.aborted && input.isEffectCurrent() &&
      Date.parse(input.reference.expiresAt) > serverNow();
    if (!current()) throw new Error("This review expired or your vault session changed.");
    const configuration = input.configuration === undefined ? undefined :
      projectCustomConnectorTurnConfigurations([input.configuration])[0];
    if (configuration && (!configuration.enabled || configuration.connectorId !== input.reference.connectorId)) {
      throw new Error("This connector configuration changed. Open the review again.");
    }
    const response = await ApiService.apiFetch(
      `/api/connectors/${encodeURIComponent(input.reference.connectorId)}/mcp/${operation}`,
      {
        method: "POST", cache: "no-store", signal: input.signal,
        isEffectCurrent: current,
        headers: {
          ...authHeaders(input.vaultOwnerToken),
          [ONE_CHAT_KEY_HEADER]: input.chatKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          conversationId: input.conversationId,
          toolName: input.reference.toolName,
          pendingHandle: input.reference.pendingHandle,
          arguments: args,
          ...(configuration ? { connectorConfiguration: configuration } : {}),
          ...(operation === "confirm" ? { directiveId: input.reference.directiveId, confirmed: true } : {}),
        }),
      },
    );
    // Learn the server's clock so the time left is the server's, not this device's.
    observeServerDate(response.headers.get("date"));
    // Never echo response bodies: they may contain private arguments or provider text.
    if (!response.ok) throw new Error("Connector review is unavailable. No automatic retry was made.");
    const payload: unknown = await response.json().catch(() => null);
    if (!current()) throw new Error("Your vault session changed. Open the review again.");
    return payload;
  }

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

  static async instagramOwnedMedia(input: {
    vaultOwnerToken: string;
    after?: string;
    signal?: AbortSignal;
  }): Promise<InstagramOwnedMediaPage> {
    const params = new URLSearchParams({ limit: "25" });
    if (input.after) params.set("after", input.after);
    const response = await ApiService.apiFetch(`/api/connectors/instagram/media?${params}`, {
      method: "GET",
      cache: "no-store",
      headers: authHeaders(input.vaultOwnerToken),
      signal: input.signal,
    });
    const page = await readJsonOrThrow<InstagramOwnedMediaPage>(response);
    if (!Array.isArray(page?.posts) ||
        page.posts.length > 25 ||
        !page.posts.every((post) =>
          typeof post?.id === "string" &&
          typeof post.caption === "string" &&
          typeof post.permalink === "string" &&
          /^https:\/\/(?:www\.)?instagram\.com\//.test(post.permalink))) {
      throw new Error("Instagram posts changed. Refresh and try again.");
    }
    return page;
  }

  static async instagramComments(input: {
    vaultOwnerToken: string; mediaId: string; after?: string; signal?: AbortSignal;
  }): Promise<InstagramCommentsPage> {
    const mediaId = instagramId(input.mediaId);
    const params = new URLSearchParams({ limit: "25" });
    const after = instagramCursor(input.after);
    if (after) params.set("after", after);
    const response = await ApiService.apiFetch(
      `/api/connectors/instagram/media/${mediaId}/comments?${params}`,
      { method: "GET", cache: "no-store", headers: authHeaders(input.vaultOwnerToken), signal: input.signal },
    );
    const page = await readJsonOrThrow<InstagramCommentsPage>(response);
    if (!Array.isArray(page?.comments) || page.comments.length > 25 ||
        !page.comments.every((item) => validInstagramNumericId(item?.id) &&
          typeof item.text === "string" && item.text.length <= 2200 &&
          typeof item.timestamp === "string" && item.timestamp.length <= 64 &&
          typeof item.username === "string" && item.username.length <= 100 &&
          typeof item.hidden === "boolean")) {
      throw new Error("Instagram comments could not be verified.");
    }
    return { comments: page.comments, nextCursor: instagramPageCursor(page.nextCursor) };
  }

  static async instagramReplyToComment(input: {
    vaultOwnerToken: string; commentId: string; message: string; signal?: AbortSignal;
  }): Promise<{ commentId: string }> {
    const commentId = instagramId(input.commentId);
    const message = instagramText(input.message, 2200);
    const response = await ApiService.apiFetch(`/api/connectors/instagram/comments/${commentId}/reply`, {
      method: "POST", cache: "no-store", signal: input.signal,
      headers: { ...authHeaders(input.vaultOwnerToken), "Content-Type": "application/json" },
      body: JSON.stringify({ confirmed: true, message }),
    });
    const result = await readJsonOrThrow<{ commentId: string }>(response);
    if (!validInstagramNumericId(result?.commentId)) {
      throw new Error("Instagram reply could not be confirmed. Check Instagram before trying again.");
    }
    return result;
  }

  static async instagramSetCommentHidden(input: {
    vaultOwnerToken: string; commentId: string; hidden: boolean; signal?: AbortSignal;
  }): Promise<{ hidden: boolean }> {
    const commentId = instagramId(input.commentId);
    const response = await ApiService.apiFetch(`/api/connectors/instagram/comments/${commentId}/hide`, {
      method: "POST", cache: "no-store", signal: input.signal,
      headers: { ...authHeaders(input.vaultOwnerToken), "Content-Type": "application/json" },
      body: JSON.stringify({ confirmed: true, hidden: input.hidden }),
    });
    const result = await readJsonOrThrow<{ hidden: boolean }>(response);
    if (result?.hidden !== input.hidden) {
      throw new Error("Instagram moderation could not be confirmed. Check Instagram before trying again.");
    }
    return result;
  }

  static async instagramDeleteComment(input: {
    vaultOwnerToken: string; commentId: string; signal?: AbortSignal;
  }): Promise<{ deleted: true }> {
    const commentId = instagramId(input.commentId);
    const response = await ApiService.apiFetch(`/api/connectors/instagram/comments/${commentId}/delete`, {
      method: "POST", cache: "no-store", signal: input.signal,
      headers: { ...authHeaders(input.vaultOwnerToken), "Content-Type": "application/json" },
      body: JSON.stringify({ confirmed: true }),
    });
    const result = await readJsonOrThrow<{ deleted: true }>(response);
    if (result?.deleted !== true) {
      throw new Error("Instagram deletion could not be confirmed. Check Instagram before trying again.");
    }
    return result;
  }

  static async instagramAccountInsight(input: {
    vaultOwnerToken: string; metric: InstagramAccountMetric; signal?: AbortSignal;
  }): Promise<InstagramInsight> {
    if (!INSTAGRAM_ACCOUNT_METRICS.includes(input.metric)) throw new Error("Invalid Instagram metric.");
    const params = new URLSearchParams({ metric: input.metric });
    const response = await ApiService.apiFetch(`/api/connectors/instagram/insights/account?${params}`, {
      method: "GET", cache: "no-store", headers: authHeaders(input.vaultOwnerToken), signal: input.signal,
    });
    return instagramInsight(await readJsonOrThrow<InstagramInsight>(response), input.metric);
  }

  static async instagramMediaInsight(input: {
    vaultOwnerToken: string; mediaId: string; metric: InstagramMediaMetric; signal?: AbortSignal;
  }): Promise<InstagramInsight> {
    const mediaId = instagramId(input.mediaId);
    if (!INSTAGRAM_MEDIA_METRICS.includes(input.metric)) throw new Error("Invalid Instagram metric.");
    const params = new URLSearchParams({ metric: input.metric });
    const response = await ApiService.apiFetch(`/api/connectors/instagram/insights/media/${mediaId}?${params}`, {
      method: "GET", cache: "no-store", headers: authHeaders(input.vaultOwnerToken), signal: input.signal,
    });
    return instagramInsight(await readJsonOrThrow<InstagramInsight>(response), input.metric);
  }

  static async instagramTaggedMedia(input: {
    vaultOwnerToken: string; after?: string; signal?: AbortSignal;
  }): Promise<InstagramTaggedMediaPage> {
    const params = new URLSearchParams({ limit: "25" });
    const after = instagramCursor(input.after);
    if (after) params.set("after", after);
    const response = await ApiService.apiFetch(`/api/connectors/instagram/tags?${params}`, {
      method: "GET", cache: "no-store", headers: authHeaders(input.vaultOwnerToken), signal: input.signal,
    });
    const page = await readJsonOrThrow<InstagramTaggedMediaPage>(response);
    if (!Array.isArray(page?.media) || page.media.length > 25 ||
        !page.media.every((item) => validInstagramNumericId(item?.id) &&
          typeof item.username === "string" && item.username.length <= 100 &&
          typeof item.timestamp === "string" && item.timestamp.length <= 64 &&
          validInstagramPermalink(item?.permalink))) {
      throw new Error("Instagram tags could not be verified.");
    }
    return { media: page.media, nextCursor: instagramPageCursor(page.nextCursor) };
  }

  static async instagramRecentMessages(input: {
    vaultOwnerToken: string; recipientId: string; signal?: AbortSignal;
  }): Promise<InstagramMessages> {
    const recipientId = instagramId(input.recipientId);
    const response = await ApiService.apiFetch(`/api/connectors/instagram/messages/${recipientId}`, {
      method: "GET", cache: "no-store", headers: authHeaders(input.vaultOwnerToken), signal: input.signal,
    });
    const result = await readJsonOrThrow<InstagramMessages>(response);
    if (!Array.isArray(result?.messages) || result.messages.length > 20 ||
        !result.messages.every((item) => validInstagramOpaqueId(item?.id) &&
          validInstagramNumericId(item.senderId) &&
          typeof item.createdTime === "string" && item.createdTime.length <= 64 &&
          typeof item.text === "string" && item.text.length <= 1000)) {
      throw new Error("Instagram messages could not be verified.");
    }
    return result;
  }

  static async instagramSendTextMessage(input: {
    vaultOwnerToken: string; recipientId: string; message: string; signal?: AbortSignal;
  }): Promise<{ messageId: string }> {
    const recipientId = instagramId(input.recipientId);
    const message = instagramText(input.message, 1000);
    if (new TextEncoder().encode(message).byteLength > 1000) {
      throw new Error("Instagram message must be at most 1,000 bytes.");
    }
    const response = await ApiService.apiFetch(`/api/connectors/instagram/messages/${recipientId}/send`, {
      method: "POST", cache: "no-store", signal: input.signal,
      headers: { ...authHeaders(input.vaultOwnerToken), "Content-Type": "application/json" },
      body: JSON.stringify({ confirmed: true, message }),
    });
    const result = await readJsonOrThrow<{ messageId: string }>(response);
    if (!INSTAGRAM_OPAQUE_ID.test(result?.messageId ?? "")) {
      throw new Error("Instagram message could not be confirmed. Check Instagram before trying again.");
    }
    return result;
  }

  static async instagramPublicEmbed(input: {
    vaultOwnerToken: string;
    postUrl: string;
    signal?: AbortSignal;
  }): Promise<{ html: string }> {
    const canonical = canonicalInstagramPublicPostUrl(input.postUrl);
    if (!canonical) throw new Error("Enter a public Instagram post or Reel URL.");
    const params = new URLSearchParams({ url: canonical });
    const response = await ApiService.apiFetch(`/api/connectors/instagram/oembed?${params}`, {
      method: "GET",
      cache: "no-store",
      headers: authHeaders(input.vaultOwnerToken),
      signal: input.signal,
    });
    return readInstagramPublicEmbed(response);
  }

  static async instagramPreparePost(input: {
    vaultOwnerToken: string;
    kind: "photo" | "reel" | "story_image" | "story_video";
    mediaUrl: string;
    caption: string;
    signal?: AbortSignal;
  }): Promise<{ containerHandle: string; kind: string }> {
    const route = {
      photo: "photo-container",
      reel: "reel-container",
      story_image: "story-image-container",
      story_video: "story-video-container",
    }[input.kind];
    const image = input.kind === "photo" || input.kind === "story_image";
    const story = input.kind === "story_image" || input.kind === "story_video";
    const response = await ApiService.apiFetch(`/api/connectors/instagram/media/${route}`, {
      method: "POST",
      cache: "no-store",
      signal: input.signal,
      headers: { ...authHeaders(input.vaultOwnerToken), "Content-Type": "application/json" },
      body: JSON.stringify({
        ...(image ? { imageUrl: input.mediaUrl } : { videoUrl: input.mediaUrl }),
        ...(!story ? { caption: input.caption } : {}),
        confirmed: true,
      }),
    });
    const result = await readJsonOrThrow<{ containerHandle: string; kind: string }>(response);
    if (!/^igc1\.[A-Za-z0-9_-]+\.[a-f0-9]{64}$/.test(result?.containerHandle ?? "")) {
      throw new Error("Instagram post preparation could not be verified.");
    }
    return result;
  }

  static async instagramContainerStatus(input: {
    vaultOwnerToken: string;
    containerHandle: string;
    signal?: AbortSignal;
  }): Promise<{ kind: string; status: string }> {
    const response = await ApiService.apiFetch(
      `/api/connectors/instagram/media/containers/${encodeURIComponent(input.containerHandle)}`,
      { method: "GET", cache: "no-store", signal: input.signal,
        headers: authHeaders(input.vaultOwnerToken) },
    );
    return readJsonOrThrow(response);
  }

  static async instagramPublishPost(input: {
    vaultOwnerToken: string;
    containerHandle: string;
    signal?: AbortSignal;
  }): Promise<{ mediaId: string }> {
    const response = await ApiService.apiFetch("/api/connectors/instagram/media/publish", {
      method: "POST",
      cache: "no-store",
      signal: input.signal,
      headers: { ...authHeaders(input.vaultOwnerToken), "Content-Type": "application/json" },
      body: JSON.stringify({ containerHandle: input.containerHandle, confirmed: true }),
    });
    const result = await readJsonOrThrow<{ mediaId: string }>(response);
    if (!/^[0-9]{1,32}$/.test(result?.mediaId ?? "")) {
      throw new Error("Instagram publication could not be verified. Check your account before retrying.");
    }
    return result;
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
    profile?: "selected" | "live";
    isEffectCurrent?: ConnectorEffectGuard;
    signal?: AbortSignal;
  }): Promise<{
    authorizeUrl: string;
    expiresAt: string;
    attemptId?: string;
    connectorId?: string;
  }> {
    return withOAuthStartDeadline(async (signal) => {
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
            profile: input.profile ?? "selected",
          }),
          signal,
          isEffectCurrent: input.isEffectCurrent,
        },
      );
      return readJsonOrThrow(response);
    }, input.signal);
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

  static async liveBackground(vaultOwnerToken: string): Promise<boolean> {
    const result = await readJsonOrThrow<{ enabled: unknown }>(
      await ApiService.apiFetch("/api/connectors/google_drive/live/background", {
        method: "GET",
        headers: authHeaders(vaultOwnerToken),
        cache: "no-store",
      }),
    );
    if (typeof result.enabled !== "boolean")
      throw new Error("Invalid background Drive access state");
    return result.enabled;
  }

  static async setLiveBackground(
    vaultOwnerToken: string,
    enabled: boolean,
  ): Promise<boolean> {
    const result = await readJsonOrThrow<{ enabled: unknown }>(
      await ApiService.apiFetch("/api/connectors/google_drive/live/background", {
        method: "POST",
        headers: {
          ...authHeaders(vaultOwnerToken),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ enabled, confirmed: true }),
      }),
    );
    if (result.enabled !== enabled)
      throw new Error("Background Drive access state was not confirmed");
    return enabled;
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
