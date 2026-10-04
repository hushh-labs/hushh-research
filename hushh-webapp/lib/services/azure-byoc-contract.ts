/**
 * The Connect Azure HTTP contract, typed and checked at the boundary.
 *
 * Three hub routes, all under the `/api/one/runtime` family with Firebase auth:
 *
 *   POST byoc/azure/authorize/begin    {subscriptionId?} -> {authorizationUrl}
 *   POST byoc/azure/authorize/complete {code, state}     -> AzureAuthorizeCompletion
 *   POST byoc/azure/upgrade/begin      {}                -> {authorizationUrl}
 *
 * Setup and update progress are read from the existing
 * `GET byoc/setup/status` record; nothing here duplicates it.
 *
 * Every payload is validated before the app acts on it. The begin routes hand
 * back an address the browser is about to navigate to, so that address must be
 * an HTTPS Microsoft identity-platform sign-in page and nothing else: a
 * malformed or misrouted answer fails closed instead of sending the person to
 * an arbitrary page.
 */

export type AzureSubscription = {
  subscriptionId: string;
  displayName: string;
  /** The Azure Resource Manager state, e.g. `Enabled`, `Disabled`, `PastDue`. */
  state: string;
};

export type AzureAuthorizationStart = { authorizationUrl: string };

/**
 * Why the hub needs a subscription choice. A personal Microsoft account cannot
 * list its subscriptions to an app, so it must name its subscription id.
 */
export type AzureSubscriptionReason =
  | "choose_subscription"
  | "no_enabled_subscription"
  | "personal_account";

const SUBSCRIPTION_REASONS: readonly AzureSubscriptionReason[] = [
  "choose_subscription",
  "no_enabled_subscription",
  "personal_account",
];

export type AzureAuthorizeCompletion =
  | { status: "setup_started"; jobId: string }
  | { status: "upgrade_started"; jobId: string }
  /** The account was identified; sign in again in its own directory for Azure. */
  | { status: "continue"; authorizationUrl: string }
  | {
      status: "needs_subscription";
      subscriptions: AzureSubscription[];
      reason?: AzureSubscriptionReason;
    };

export type AzureByocFailure =
  | "AZURE_AUTHORIZE_BEGIN_FAILED"
  | "AZURE_AUTHORIZE_COMPLETE_FAILED"
  | "AZURE_UPGRADE_BEGIN_FAILED";

/** The three routes, relative to `/api/one/runtime/byoc/azure/`. */
export type AzureByocPath = "authorize/begin" | "authorize/complete" | "upgrade/begin";

export type AzureByocErrorCode = AzureByocFailure | "AZURE_RESPONSE_INVALID";

/**
 * Microsoft identity platform sign-in hosts: the commercial cloud (both
 * documented authority hosts) and Azure Government, which the design keeps one
 * settings change away.
 */
export const MICROSOFT_SIGN_IN_HOSTS: ReadonlySet<string> = new Set([
  "login.microsoftonline.com",
  "login.microsoft.com",
  "login.microsoftonline.us",
]);

/** The hub's own reasons are short sentences; anything longer is not one. */
const MAX_SERVER_MESSAGE_LENGTH = 240;
const MAX_AUTHORIZATION_URL_LENGTH = 16_000;

export class AzureByocError extends Error {
  readonly code: AzureByocErrorCode;
  readonly httpStatus: number | null;
  /** The hub's typed refusal code (`detail.code`), when it sent one. */
  readonly serverCode: string | null;
  /** The hub's person-facing reason (`detail.message`), when it sent a usable one. */
  readonly serverMessage: string | null;

  constructor(
    code: AzureByocErrorCode,
    init: {
      httpStatus?: number | null;
      serverCode?: string | null;
      serverMessage?: string | null;
    } = {},
  ) {
    super(code);
    this.name = "AzureByocError";
    this.code = code;
    this.httpStatus = init.httpStatus ?? null;
    this.serverCode = init.serverCode ?? null;
    this.serverMessage = init.serverMessage ?? null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidResponse(): AzureByocError {
  return new AzureByocError("AZURE_RESPONSE_INVALID");
}

/**
 * A refusal from the hub. Its reason is kept only when it arrives in the
 * typed shape (`detail: {code, message}`): a bare string or an unhandled
 * error page is not a sentence written for the person and is never shown.
 */
export function azureByocErrorFromResponse(
  failure: AzureByocFailure,
  httpStatus: number,
  payload: unknown,
): AzureByocError {
  const detail = isRecord(payload) ? payload.detail : null;
  const serverCode = isRecord(detail) && typeof detail.code === "string" ? detail.code : null;
  const rawMessage = isRecord(detail) && typeof detail.message === "string" ? detail.message.trim() : "";
  const serverMessage =
    serverCode && rawMessage && rawMessage.length <= MAX_SERVER_MESSAGE_LENGTH ? rawMessage : null;
  return new AzureByocError(failure, { httpStatus, serverCode, serverMessage });
}

/** The body of a hub answer, or the typed refusal when it is not a success. */
export async function readAzureByocResponse(
  response: Pick<Response, "ok" | "status" | "json">,
  failure: AzureByocFailure,
): Promise<unknown> {
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) throw azureByocErrorFromResponse(failure, response.status, payload);
  return payload;
}

function isMicrosoftSignInUrl(url: URL): boolean {
  return (
    url.protocol === "https:" &&
    !url.username &&
    !url.password &&
    !url.port &&
    !url.hash &&
    MICROSOFT_SIGN_IN_HOSTS.has(url.hostname)
  );
}

export function parseAzureAuthorizationStart(payload: unknown): AzureAuthorizationStart {
  const raw = isRecord(payload) ? payload.authorizationUrl : null;
  if (typeof raw !== "string" || raw.length > MAX_AUTHORIZATION_URL_LENGTH) {
    throw invalidResponse();
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw invalidResponse();
  }
  if (!isMicrosoftSignInUrl(url)) throw invalidResponse();
  return { authorizationUrl: url.href };
}

function toSubscription(value: unknown): AzureSubscription | null {
  if (!isRecord(value)) return null;
  const { subscriptionId, displayName, state } = value;
  if (typeof subscriptionId !== "string" || !subscriptionId.trim()) return null;
  if (typeof displayName !== "string" || typeof state !== "string") return null;
  return { subscriptionId, displayName, state };
}

export function parseAzureAuthorizeCompletion(payload: unknown): AzureAuthorizeCompletion {
  if (!isRecord(payload)) throw invalidResponse();
  const { status } = payload;
  if (status === "setup_started" || status === "upgrade_started") {
    const { jobId } = payload;
    if (typeof jobId !== "string" || !jobId.trim()) throw invalidResponse();
    return { status, jobId };
  }
  if (status === "continue") {
    // The browser navigates here next: the same Microsoft-only check as a begin.
    return { status, ...parseAzureAuthorizationStart(payload) };
  }
  if (status === "needs_subscription") {
    if (!Array.isArray(payload.subscriptions)) throw invalidResponse();
    const subscriptions = payload.subscriptions
      .map(toSubscription)
      .filter((entry): entry is AzureSubscription => entry !== null);
    const reason = SUBSCRIPTION_REASONS.find((known) => known === payload.reason);
    return reason ? { status, subscriptions, reason } : { status, subscriptions };
  }
  throw invalidResponse();
}

const SUBSCRIPTION_ID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

/** An Azure subscription id is a GUID; anything else is refused before sign-in. */
export function isAzureSubscriptionId(value: string): boolean {
  return SUBSCRIPTION_ID.test(value.trim());
}

/** Only an enabled subscription can hold new resources. */
export function isUsableAzureSubscription(subscription: AzureSubscription): boolean {
  return subscription.state.trim().toLowerCase() === "enabled";
}
