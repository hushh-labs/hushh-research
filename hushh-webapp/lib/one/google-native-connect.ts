/**
 * Connect Gmail, Calendar, Drive or Contacts to the person's own agent with
 * Hussh's native Google app clients.
 *
 * The phone runs the Google sign-in with PKCE on Hussh's iOS or Android
 * client, which has no client secret. The one-time code and its verifier are
 * sealed to the agent (`connector-credential-seal.ts`) and sent owner-direct to
 * the agent's door (`PUT /api/one/pod/connectors/{connector}`). The agent
 * redeems the code with Google itself, so Hussh's hub never sees the code, the
 * token or anything the connector reads.
 *
 * On the web there is no native client, so the person finishes on their phone
 * (a QR handoff). Native uses a separate public-client authorization adapter; the QR contains
 * only a connector intent.
 */
import { snapshotVaultSessionEpoch, isVaultSessionEpochCurrent } from '@/lib/vault/session-epoch';
import { Capacitor } from "@capacitor/core";
import { ApiService } from "@/lib/services/api-service";
import { AuthService } from '@/lib/services/auth-service';
import { openGoogleConnectorAuth } from './google-connector-auth';
import { base64UrlEncode } from "./ai-selection-seal";
import { googleConnectorTransition, type GoogleConnectorTransition, type AuthorizationCodePlaintext, type GoogleClientProfile, type GoogleConnector } from "./connector-credential-seal";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const G = "https://www.googleapis.com/auth/";
const IDENTITY = ["openid", "email"];

/** What each connector asks for at sign-in; the agent narrows further per use. */
export const GOOGLE_CONNECTOR_SCOPES: Record<GoogleConnector, string[]> = {
  gmail: [...IDENTITY, `${G}gmail.modify`],
  calendar: [...IDENTITY, `${G}calendar.events`, `${G}calendar.freebusy`],
  drive: [...IDENTITY, `${G}drive.readonly`],
  contacts: [...IDENTITY, `${G}contacts.readonly`],
};

export type NativeGoogleClient = { profile: GoogleClientProfile; clientId: string; redirectUri: string };

export type ConnectOutcome =
  | { ok: true; status: "connected"; legacyCleanup?: 'unconfirmed' }
  | { ok: false; code: string }
  | { ok: false; code: "PHONE_HANDOFF_REQUIRED"; handoff: PhoneHandoff };

export type PhoneHandoff = { connector: GoogleConnector; deepLink: string };

/** The injected native glue: open Google's sign-in sheet, resolve with the final redirect URL. */
export type OpenAuthSession = (authorizationUrl: string, redirectUri: string) => Promise<string>;

export type GoogleConnectorTransitionReview = {
  services: readonly GoogleConnector[];
  scope: 'all_google_project_grants';
};
export type GoogleConnectorConnectOptions = {
  openAuthSession?: OpenAuthSession;
  platform?: string;
  isCurrent?: () => boolean;
  /** Mounted, memory-only owner capability; never recovered from storage. */
  vaultOwnerCapability?: string | null;
  confirmLegacyTransition?: (terms: GoogleConnectorTransitionReview) => Promise<boolean>;
};

async function prepareTransition(owner: string, client: NativeGoogleClient, capability: string, confirmed: boolean): Promise<GoogleConnectorTransition | GoogleConnectorTransitionReview> {
  const response = await ApiService.apiFetch('/api/one/google/connect/transition/prepare', {
    method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json', 'X-Consent-Token': capability },
    body: JSON.stringify({ user_id: owner, client_profile: client.profile, confirmed }),
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error(refusalCode(body, response.status));
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('GOOGLE_TRANSITION_INVALID');
  const record = body as Record<string, unknown>;
  if (record.status === 'ready' && Object.keys(record).length === 2) return googleConnectorTransition(record.transition);
  if (record.status === 'confirmation_required' && Object.keys(record).length === 3 &&
      record.scope === 'all_google_project_grants' && Array.isArray(record.services) &&
      record.services.length > 0 && record.services.length <= 4 &&
      new Set(record.services).size === record.services.length &&
      record.services.every((service) => ['gmail', 'calendar', 'drive', 'contacts'].includes(String(service)))) {
    return { services: record.services as GoogleConnector[], scope: 'all_google_project_grants' };
  }
  throw new Error('GOOGLE_TRANSITION_INVALID');
}

/** Hussh's native client for this device, from the frontend's runtime config. Null on the web. */
export function nativeGoogleClient(platform: string = Capacitor.getPlatform()): NativeGoogleClient | null {
  if (platform === "ios") {
    const clientId = (process.env.NEXT_PUBLIC_GOOGLE_IOS_CONNECTOR_CLIENT_ID ?? "").trim();
    if (!clientId) return null;
    // Google's iOS client redirects only to its own reversed client id scheme.
    const scheme = `com.googleusercontent.apps.${clientId.replace(/\.apps\.googleusercontent\.com$/, "")}`;
    return { profile: "hussh_ios", clientId, redirectUri: `${scheme}:/oauth2redirect` };
  }
  if (platform === "android") {
    const clientId = (process.env.NEXT_PUBLIC_GOOGLE_ANDROID_CONNECTOR_CLIENT_ID ?? "").trim();
    const redirectUri = (process.env.NEXT_PUBLIC_GOOGLE_ANDROID_CONNECTOR_REDIRECT_URI ?? "").trim();
    if (!clientId || redirectUri !== 'com.hussh.app:/oauth2redirect' ||
        !['dev', 'development'].includes(process.env.NEXT_PUBLIC_APP_ENV ?? '') ||
        process.env.NEXT_PUBLIC_GOOGLE_ANDROID_CONNECTOR_DEV_ENABLED !== 'true') return null;
    return { profile: "hussh_android", clientId, redirectUri };
  }
  return null;
}

/** RFC 7636: a 43 to 128 character verifier and its S256 challenge. */
export async function createPkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64UrlEncode(globalThis.crypto.getRandomValues(new Uint8Array(48)));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64UrlEncode(new Uint8Array(digest)) };
}

export function googleAuthorizationUrl(input: {
  client: NativeGoogleClient;
  connector: GoogleConnector;
  challenge: string;
  state: string;
}): string {
  const params = new URLSearchParams({
    client_id: input.client.clientId,
    redirect_uri: input.client.redirectUri,
    response_type: "code",
    scope: GOOGLE_CONNECTOR_SCOPES[input.connector].join(" "),
    code_challenge: input.challenge,
    code_challenge_method: "S256",
    state: input.state,
    // A refresh token is what the agent keeps; consent makes Google issue one.
    access_type: "offline",
    prompt: "consent",
    // Each connector is its own narrow login, never the union of past grants.
    include_granted_scopes: "false",
  });
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

/** The code from Google's redirect, only when the state is the one this sign-in sent. */
export function codeFromRedirect(redirectUrl: string, expectedState: string, expectedRedirectUri?: string): string {
  let params: URLSearchParams;
  try {
    const redirect = new URL(redirectUrl);
    params = new URLSearchParams(redirect.search);
    if (redirect.hash || redirect.username || redirect.password ||
        [...params.keys()].some((key) => params.getAll(key).length !== 1)) throw new Error('SIGN_IN_INCOMPLETE');
    redirect.search = '';
    if (expectedRedirectUri && redirect.toString() !== expectedRedirectUri) throw new Error('SIGN_IN_INCOMPLETE');
  } catch {
    throw new Error("SIGN_IN_INCOMPLETE");
  }
  if (params.get("error")) throw new Error("SIGN_IN_CANCELLED");
  if (params.get("state") !== expectedState) throw new Error("SIGN_IN_INCOMPLETE");
  const code = params.get("code");
  if (!code) throw new Error("SIGN_IN_INCOMPLETE");
  return code;
}

function refusalCode(body: unknown, status: number): string {
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const detail = record.detail && typeof record.detail === "object" ? (record.detail as Record<string, unknown>) : record;
  const code = String(detail.code ?? record.code ?? "");
  if (code) return code;
  return status === 404 || status === 405 ? "AGENT_NEEDS_UPDATE" : "AGENT_UNREACHABLE";
}

/** PUT the login to the agent. The owner-direct transport seals it to the agent first. */
export async function sendConnectorCredentialToAgent(
  connector: GoogleConnector,
  plaintext: AuthorizationCodePlaintext & { transition?: GoogleConnectorTransition },
  expectedOwner?: string,
): Promise<ConnectOutcome> {
  let response: Response;
  if (expectedOwner && AuthService.getCurrentUser()?.uid !== expectedOwner) return { ok: false, code: 'POD_OWNER_CHANGED' };
  try {
    response = await ApiService.ownerPodRequest(`connectors/${connector}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(plaintext),
    });
  } catch (error) {
    const value = error instanceof Error ? ('code' in error ? String(error.code) : error.message) : '';
    const code = value === 'POD_VAULT_SESSION_CHANGED' ? 'PRIVATE_AGENT_UNLOCK_REQUIRED' : value;
    return { ok: false, code: ['DEVICE_UNSUPPORTED', 'POD_OWNER_CHANGED', 'PRIVATE_AGENT_UNLOCK_REQUIRED', 'OWNER_SESSION_REQUIRED', 'AGENT_KEY_MISMATCH'].includes(code) ? code : 'AGENT_UNREACHABLE' };
  }
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (response.ok && body?.status === "connected") return { ok: true, status: "connected", ...(body.legacyCleanup === 'unconfirmed' ? { legacyCleanup: 'unconfirmed' as const } : {}) };
  return { ok: false, code: refusalCode(body, response.status) };
}

/** Intent only: the phone resolves its own owner and agent, never a QR-supplied endpoint. */
export function phoneHandoff(connector: GoogleConnector): PhoneHandoff {
  return { connector, deepLink: `hushh://one/connect/google/${connector}` };
}

/** Sign in on this phone, seal the code to the agent, and let the agent redeem it. */
export async function connectGoogleConnector(
  connector: GoogleConnector,
  deps: GoogleConnectorConnectOptions = {},
): Promise<ConnectOutcome> {
  const platform = deps.platform ?? Capacitor.getPlatform();
  if (platform === 'web') return { ok: false, code: "PHONE_HANDOFF_REQUIRED", handoff: phoneHandoff(connector) };
  const client = nativeGoogleClient(platform);
  if (!client) return { ok: false, code: platform === 'android' ? 'ANDROID_CONNECTOR_DEV_REQUIRED' : 'NATIVE_CLIENT_NOT_CONFIGURED' };
  const vaultEpoch = snapshotVaultSessionEpoch();
  const owner = AuthService.getCurrentUser()?.uid;
  const current = () => AuthService.getCurrentUser()?.uid === owner && isVaultSessionEpochCurrent(vaultEpoch) && (deps.isCurrent?.() ?? true);
  const changedCode = () => !isVaultSessionEpochCurrent(vaultEpoch) ? 'PRIVATE_AGENT_UNLOCK_REQUIRED' : 'POD_OWNER_CHANGED';
  if (!owner) return { ok: false, code: 'PRIVATE_AGENT_SIGN_IN_REQUIRED' };
  const capability = deps.vaultOwnerCapability;
  if (!capability) return { ok: false, code: 'PRIVATE_AGENT_UNLOCK_REQUIRED' };
  if (!current()) return { ok: false, code: changedCode() };
  // Prove this installation can reach its owner's session-only connector door
  // before asking Google for any new authority.
  try {
    const ready = await ApiService.ownerPodRequest(`connectors/${connector}`, { method: 'GET' });
    if (!ready.ok) return { ok: false, code: refusalCode(await ready.json().catch(() => null), ready.status) };
  } catch { return { ok: false, code: 'AGENT_UNREACHABLE' }; }
  if (!current()) return { ok: false, code: changedCode() };
  let transition: GoogleConnectorTransition;
  try {
    let prepared = await prepareTransition(owner, client, capability, false);
    if (!current()) return { ok: false, code: changedCode() };
    if ('services' in prepared) {
      if (!deps.confirmLegacyTransition) return { ok: false, code: 'GOOGLE_TRANSITION_CONFIRMATION_REQUIRED' };
      const approved = await deps.confirmLegacyTransition(prepared);
      if (!current()) return { ok: false, code: changedCode() };
      if (!approved) return { ok: false, code: 'SIGN_IN_CANCELLED' };
      prepared = await prepareTransition(owner, client, capability, true);
      if (!current()) return { ok: false, code: changedCode() };
      if ('services' in prepared) return { ok: false, code: 'GOOGLE_TRANSITION_CONFIRMATION_REQUIRED' };
    }
    transition = prepared;
  } catch (error) {
    return { ok: false, code: current() ? (error instanceof Error ? error.message : 'GOOGLE_TRANSITION_UNAVAILABLE') : changedCode() };
  }
  const { verifier, challenge } = await createPkce();
  if (!current()) return { ok: false, code: changedCode() };
  const state = base64UrlEncode(globalThis.crypto.getRandomValues(new Uint8Array(16)));
  let code: string;
  try {
    const redirect = await (deps.openAuthSession ?? openGoogleConnectorAuth)(
      googleAuthorizationUrl({ client, connector, challenge, state }),
      client.redirectUri,
    );
    if (!current()) throw new Error(changedCode());
    code = codeFromRedirect(redirect, state, client.redirectUri);
  } catch (error) {
    return { ok: false, code: error instanceof Error ? error.message : "SIGN_IN_INCOMPLETE" };
  }
  const delivered = await sendConnectorCredentialToAgent(connector, {
    kind: "authorization_code",
    clientProfile: client.profile,
    clientId: client.clientId,
    code,
    codeVerifier: verifier,
    redirectUri: client.redirectUri,
    scopes: GOOGLE_CONNECTOR_SCOPES[connector],
    transition,
  }, owner);
  return current() ? delivered : { ok: false, code: changedCode() };
}

/** Plain words for every outcome the person can see. */
export function connectRefusalMessage(code: string, connectorName: string): string {
  switch (code) {
    case "PHONE_HANDOFF_REQUIRED": return `Finish connecting ${connectorName} on your phone. Scan the code with the Hussh app.`;
    case "SIGN_IN_CANCELLED": return `${connectorName} was not connected. You can try again any time.`;
    case "SIGN_IN_INCOMPLETE": return `Google did not finish signing you in. Try again.`;
    case "NATIVE_SIGN_IN_UNAVAILABLE": return `This version of the app does not support connecting ${connectorName} yet. Update the app, then try again.`;
    case 'NATIVE_CLIENT_NOT_CONFIGURED': return `Google sign-in is not configured for this app build.`;
    case 'ANDROID_CONNECTOR_DEV_REQUIRED': return `Connecting Google on Android is available in the development build after Google enables this client.`;
    case 'PRIVATE_AGENT_UNLOCK_REQUIRED': return `Your vault session changed. Unlock your vault and start connecting again.`;
    case 'PRIVATE_AGENT_SIGN_IN_REQUIRED': return `Sign in before connecting Google to your private agent.`;
    case 'GOOGLE_TRANSITION_CONFIRMATION_REQUIRED': return `Review the Google connection change before continuing.`;
    case 'GOOGLE_TRANSITION_PROVIDER_UNCONFIRMED': return `Google could not confirm the previous connection was removed. Try again before signing in.`;
    case 'GOOGLE_TRANSITION_BUSY': return `Another Google connection change is still finishing. Try again shortly.`;
    case 'GOOGLE_TRANSITION_CONNECTION_CHANGED': return `Your Google connection changed. Review it again before continuing.`;
    case 'GOOGLE_TRANSITION_PRIVATE_POD_REQUIRED': return `Set up your private agent before connecting Google.`;
    case 'DEVICE_UNSUPPORTED': return `This app cannot protect the Google connection on this device. Update the app and try again.`;
    case 'OWNER_SESSION_REQUIRED':
    case 'AGENT_KEY_MISMATCH': return `Your private agent's identity could not be verified. Refresh its connection and try again.`;
    case 'POD_OWNER_CHANGED': return `Your signed-in account changed. Start connecting again.`;
    case "SCOPE_NOT_GRANTED": return `Google did not grant access to ${connectorName}. Try again and allow access.`;
    case "REFRESH_TOKEN_MISSING": return `Google did not give your agent lasting access. Try again.`;
    case "CODE_REFUSED": return `Google did not accept this sign-in. Try again.`;
    case "ACCOUNT_UNVERIFIED": return `Your agent could not confirm which Google account signed in. Try again.`;
    case "PROVIDER_UNREACHABLE": return `Google could not be reached. Try again in a moment.`;
    case "STALE_CREDENTIAL": return `This sign-in changed on another device. Try again.`;
    case "BAD_ENVELOPE": return `Your agent could not read this request. Refresh the app and try again.`;
    case "AGENT_NEEDS_UPDATE": return `Your agent needs an update to connect ${connectorName}.`;
    default: return `Your private agent could not be reached. Try again in a moment.`;
  }
}
