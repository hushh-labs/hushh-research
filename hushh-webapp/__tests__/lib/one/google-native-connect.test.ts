/**
 * Native Google connect: PKCE on Hussh's phone client, state checked, the code
 * sent only to the agent's own door, and a web visitor sent to their phone.
 */
import { advanceVaultSessionEpoch } from '@/lib/vault/session-epoch';
import { beforeEach, describe, expect, it, vi } from "vitest";

const { ownerPodRequest, apiFetch, nativeOpen, owner } = vi.hoisted(() => ({ ownerPodRequest: vi.fn(), apiFetch: vi.fn(), nativeOpen: vi.fn(), owner: { uid: 'owner' } }));
vi.mock("@/lib/services/api-service", () => ({ ApiService: { apiFetch: (...args: unknown[]) => apiFetch(...args), ownerPodRequest: (...args: unknown[]) => ownerPodRequest(...args) } }));
vi.mock("@capacitor/core", () => ({ Capacitor: { getPlatform: () => "web" }, registerPlugin: () => ({ open: nativeOpen }) }));
vi.mock('@/lib/services/auth-service', () => ({ AuthService: { getCurrentUser: () => owner } }));

import {
  codeFromRedirect,
  connectGoogleConnector,
  connectRefusalMessage,
  createPkce,
  googleAuthorizationUrl,
  nativeGoogleClient,
} from "@/lib/one/google-native-connect";
import { googleConnectorIntent } from '@/lib/one/google-connector-intent';
import { base64UrlEncode } from "@/lib/one/ai-selection-seal";

const TRANSITION = { id: `gct_${'a'.repeat(32)}`, nonce: 'b'.repeat(43) };
const CAPABILITY = 'synthetic-owner-capability';

const IOS_CLIENT = "123456789012-abcdefghijklmnop.apps.googleusercontent.com";

beforeEach(() => {
  apiFetch.mockReset().mockImplementation(async () => new Response(JSON.stringify({ status: 'ready', transition: TRANSITION })));
  ownerPodRequest.mockReset();
  ownerPodRequest.mockResolvedValue(new Response(JSON.stringify({ connectorId: 'gmail', status: 'connected' })));
  owner.uid = 'owner';
  nativeOpen.mockReset();
  nativeOpen.mockRejectedValue(new Error('SIGN_IN_CANCELLED'));
  vi.stubEnv("NEXT_PUBLIC_GOOGLE_IOS_CONNECTOR_CLIENT_ID", IOS_CLIENT);
});

describe("google native connect", () => {
  it('requires the mounted owner capability before admission or Google authorization', async () => {
    const openAuthSession = vi.fn();
    await expect(connectGoogleConnector('gmail', { platform: 'ios', openAuthSession })).resolves.toEqual({ ok: false, code: 'PRIVATE_AGENT_UNLOCK_REQUIRED' });
    expect(ownerPodRequest).not.toHaveBeenCalled();
    expect(apiFetch).not.toHaveBeenCalled();
    expect(openAuthSession).not.toHaveBeenCalled();
  });

  it('starts PKCE only after exact project-wide owner confirmation and a ready receipt', async () => {
    const terms = { services: ['gmail', 'drive'], scope: 'all_google_project_grants' };
    apiFetch.mockImplementation(async (_path, init) => new Response(JSON.stringify(JSON.parse(init.body).confirmed
      ? { status: 'ready', transition: TRANSITION } : { status: 'confirmation_required', ...terms })));
    let approve!: (value: boolean) => void;
    const confirmLegacyTransition = vi.fn(() => new Promise<boolean>((resolve) => { approve = resolve; }));
    const openAuthSession = vi.fn().mockRejectedValue(new Error('SIGN_IN_CANCELLED'));
    const attempt = connectGoogleConnector('gmail', { platform: 'ios', vaultOwnerCapability: CAPABILITY, confirmLegacyTransition, openAuthSession });
    await vi.waitFor(() => expect(confirmLegacyTransition).toHaveBeenCalledWith(terms));
    expect(openAuthSession).not.toHaveBeenCalled();
    expect(apiFetch).toHaveBeenCalledTimes(1);
    approve(true);
    await expect(attempt).resolves.toEqual({ ok: false, code: 'SIGN_IN_CANCELLED' });
    expect(JSON.parse(apiFetch.mock.calls[1][1].body)).toEqual({ user_id: 'owner', client_profile: 'hussh_ios', confirmed: true });
    expect(openAuthSession).toHaveBeenCalledOnce();
    // Declining the same terms must neither revoke nor open Google authorization.
    apiFetch.mockClear(); openAuthSession.mockClear();
    await expect(connectGoogleConnector('gmail', { platform: 'ios', vaultOwnerCapability: CAPABILITY,
      confirmLegacyTransition: async () => false, openAuthSession })).resolves.toEqual({ ok: false, code: 'SIGN_IN_CANCELLED' });
    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(openAuthSession).not.toHaveBeenCalled();
  });

  it('refuses stale confirmation and credential-bearing transition metadata before PKCE', async () => {
    const openAuthSession = vi.fn();
    apiFetch.mockImplementation(async () => new Response(JSON.stringify({ status: 'confirmation_required', services: ['gmail'], scope: 'all_google_project_grants' })));
    await expect(connectGoogleConnector('gmail', { platform: 'ios', vaultOwnerCapability: CAPABILITY,
      confirmLegacyTransition: async () => { advanceVaultSessionEpoch(); return true; }, openAuthSession })).resolves.toEqual({ ok: false, code: 'PRIVATE_AGENT_UNLOCK_REQUIRED' });
    expect(apiFetch).toHaveBeenCalledTimes(1);
    apiFetch.mockImplementation(async () => new Response(JSON.stringify({ status: 'ready', transition: { ...TRANSITION, code: 'never-accepted' } })));
    await expect(connectGoogleConnector('gmail', { platform: 'ios', vaultOwnerCapability: CAPABILITY, openAuthSession })).resolves.toEqual({ ok: false, code: 'GOOGLE_TRANSITION_INVALID' });
    expect(openAuthSession).not.toHaveBeenCalled();
  });

  it('discards the provider code if the vault session locks during authorization', async () => {
    const outcome = await connectGoogleConnector('gmail', { platform: 'ios', vaultOwnerCapability: CAPABILITY, openAuthSession: async (url, redirect) => {
      const state = new URL(url).searchParams.get('state');
      advanceVaultSessionEpoch();
      return `${redirect}?code=never-delivered&state=${state}`;
    } });
    expect(outcome).toEqual({ ok: false, code: 'PRIVATE_AGENT_UNLOCK_REQUIRED' });
    expect(ownerPodRequest).toHaveBeenCalledTimes(1); // preflight only
    expect(ownerPodRequest.mock.calls[0][1].method).toBe('GET');
  });

  it("makes an RFC 7636 S256 pair", async () => {
    const { verifier, challenge } = await createPkce();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
    expect(challenge).toBe(base64UrlEncode(digest));
  });

  it("asks Google for a narrow, offline, PKCE login on the iOS client", () => {
    const client = nativeGoogleClient("ios")!;
    expect(client.redirectUri).toBe("com.googleusercontent.apps.123456789012-abcdefghijklmnop:/oauth2redirect");
    const url = new URL(googleAuthorizationUrl({ client, connector: "gmail", challenge: "c", state: "s" }));
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: IOS_CLIENT,
      code_challenge_method: "S256",
      access_type: "offline",
      include_granted_scopes: "false",
      scope: "openid email https://www.googleapis.com/auth/gmail.modify",
    });
    expect(url.searchParams.has("client_secret")).toBe(false);
  });

  it("accepts a code only with the state this sign-in sent", () => {
    expect(codeFromRedirect("x:/cb?code=abc&state=s1", "s1")).toBe("abc");
    expect(() => codeFromRedirect("x:/cb?code=abc&state=other", "s1")).toThrow("SIGN_IN_INCOMPLETE");
    expect(() => codeFromRedirect("x:/cb?error=access_denied&state=s1", "s1")).toThrow("SIGN_IN_CANCELLED");
  });

  it("sends the code and verifier only to the agent's connector door", async () => {
    ownerPodRequest.mockResolvedValue(new Response(JSON.stringify({ connectorId: "gmail", status: "connected" }), { status: 200 }));
    const openAuthSession = vi.fn(async (authorizationUrl: string) => {
      const state = new URL(authorizationUrl).searchParams.get("state");
      return `${nativeGoogleClient('ios')!.redirectUri}?code=4/0Acode&state=${state}`;
    });
    const outcome = await connectGoogleConnector("gmail", { platform: "ios", vaultOwnerCapability: CAPABILITY, openAuthSession });
    expect(outcome).toEqual({ ok: true, status: "connected" });
    const [route, init] = ownerPodRequest.mock.calls.find(([, init]) => init.method === 'PUT') as [string, RequestInit];
    expect(route).toBe("connectors/gmail");
    expect(init.method).toBe("PUT");
    const sent = JSON.parse(String(init.body));
    expect(sent).toMatchObject({ kind: "authorization_code", clientProfile: "hussh_ios", clientId: IOS_CLIENT, code: "4/0Acode" });
    expect(sent.transition).toEqual(TRANSITION);
    expect(apiFetch).toHaveBeenCalledWith('/api/one/google/connect/transition/prepare', expect.objectContaining({
      headers: expect.objectContaining({ 'X-Consent-Token': CAPABILITY }),
      body: JSON.stringify({ user_id: 'owner', client_profile: 'hussh_ios', confirmed: false }),
    }));
    expect(JSON.stringify(apiFetch.mock.calls)).not.toContain('4/0Acode');
    expect(sent.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
  });

  it("passes the agent's refusal code through and words it plainly", async () => {
    ownerPodRequest.mockResolvedValue(new Response(JSON.stringify({ code: "SCOPE_NOT_GRANTED" }), { status: 422 }));
    const openAuthSession = async (u: string) => `${nativeGoogleClient('ios')!.redirectUri}?code=c&state=${new URL(u).searchParams.get("state")}`;
    const outcome = await connectGoogleConnector("drive", { platform: "ios", vaultOwnerCapability: CAPABILITY, openAuthSession });
    expect(outcome).toEqual({ ok: false, code: "SCOPE_NOT_GRANTED" });
    expect(connectRefusalMessage("SCOPE_NOT_GRANTED", "Drive")).toBe("Google did not grant access to Drive. Try again and allow access.");
  });

  it("sends a web visitor to their phone and never calls the agent", async () => {
    const outcome = await connectGoogleConnector("calendar", { platform: "web" });
    expect(outcome).toMatchObject({ ok: false, code: "PHONE_HANDOFF_REQUIRED", handoff: { connector: "calendar" } });
    expect(ownerPodRequest).not.toHaveBeenCalled();
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("uses the separate native public-client adapter and handles cancellation", async () => {
    const outcome = await connectGoogleConnector("gmail", { platform: "ios", vaultOwnerCapability: CAPABILITY });
    expect(outcome).toEqual({ ok: false, code: "SIGN_IN_CANCELLED" });
    expect(nativeOpen).toHaveBeenCalledOnce();
    expect(ownerPodRequest.mock.calls.some(([, init]) => init.method === 'PUT')).toBe(false);
  });
  it('refuses callback substitution, duplicate state and owner changes before credentials leave', async () => {
    const base = nativeGoogleClient('ios')!.redirectUri;
    expect(() => codeFromRedirect(`evil:/cb?code=secret&state=s`, 's', base)).toThrow();
    expect(() => codeFromRedirect(`${base}?code=secret&state=s&state=s`, 's', base)).toThrow();
    const outcome = await connectGoogleConnector('gmail', { platform: 'ios', vaultOwnerCapability: CAPABILITY, openAuthSession: async (url) => {
      owner.uid = 'other';
      return `${base}?code=secret&state=${new URL(url).searchParams.get('state')}`;
    } });
    expect(outcome).toEqual({ ok: false, code: 'POD_OWNER_CHANGED' });
    expect(ownerPodRequest.mock.calls.some(([, init]) => init.method === 'PUT')).toBe(false);
  });
  it('accepts only connector intent in a QR, without any owner, endpoint or OAuth material', () => {
    expect(googleConnectorIntent('hushh://one/connect/google/drive')).toBe('drive');
    for (const suffix of ['?code=secret', '?owner=user', '?endpoint=https://evil', '#verifier']) {
      expect(googleConnectorIntent(`hushh://one/connect/google/drive${suffix}`)).toBeNull();
    }
    expect(googleConnectorIntent('https://evil/connect/google/drive')).toBeNull();
  });
  it('keeps Android closed until both the development lane and public-client opt-in are set', () => {
    vi.stubEnv('NEXT_PUBLIC_GOOGLE_ANDROID_CONNECTOR_CLIENT_ID', IOS_CLIENT);
    vi.stubEnv('NEXT_PUBLIC_GOOGLE_ANDROID_CONNECTOR_REDIRECT_URI', 'com.hussh.app:/oauth2redirect');
    vi.stubEnv('NEXT_PUBLIC_GOOGLE_ANDROID_CONNECTOR_DEV_ENABLED', 'true');
    vi.stubEnv('NEXT_PUBLIC_APP_ENV', 'uat');
    expect(nativeGoogleClient('android')).toBeNull();
    vi.stubEnv('NEXT_PUBLIC_APP_ENV', 'dev');
    expect(nativeGoogleClient('android')?.profile).toBe('hussh_android');
    vi.stubEnv('NEXT_PUBLIC_GOOGLE_ANDROID_CONNECTOR_DEV_ENABLED', 'false');
    expect(nativeGoogleClient('android')).toBeNull();
  });
});
