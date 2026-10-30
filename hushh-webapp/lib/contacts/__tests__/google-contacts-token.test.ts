import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GOOGLE_SIGNUP_AUTH_TIMEOUT_MS,
  googleSignupConfigured,
  requestGoogleSignupToken,
} from "../../auth/google-signup-token";

import {
  GOOGLE_CONTACTS_AUTH_TIMEOUT_MS,
  isGoogleContactsConsentCancelled,
  preloadGoogleContactsAuth,
  requestGoogleContactsToken,
} from "../google-contacts-token";

const CONTACTS_SCOPE = "https://www.googleapis.com/auth/contacts.readonly";
const SIGNUP_IDENTITY_SCOPE = "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile";

type TokenResponse = {
  access_token?: string;
  error?: string;
  scope?: string;
};

type TokenClientConfig = {
  client_id: string;
  scope: string;
  include_granted_scopes: boolean;
  callback: (response: TokenResponse) => void;
  error_callback?: (error: { type?: string }) => void;
};

describe("Google Contacts token client", () => {
  let capturedConfig: TokenClientConfig | null;
  let requestAccessToken: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.stubEnv(
      "NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID",
      "uat-client.apps.googleusercontent.com",
    );
    vi.stubEnv(
      "NEXT_PUBLIC_GOOGLE_SIGN_IN_CLIENT_ID",
      "firebase-auth-client.apps.googleusercontent.com",
    );
    capturedConfig = null;
    requestAccessToken = vi.fn();
    (
      globalThis as unknown as {
        google?: unknown;
      }
    ).google = {
      accounts: {
        oauth2: {
          initTokenClient: (config: TokenClientConfig) => {
            capturedConfig = config;
            return { requestAccessToken };
          },
        },
      },
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    Reflect.deleteProperty(globalThis, "google");
    document
      .querySelectorAll('script[src="https://accounts.google.com/gsi/client"]')
      .forEach((script) => script.remove());
    vi.unstubAllEnvs();
  });

  it("preloads without opening account UI", async () => {
    await expect(preloadGoogleContactsAuth()).resolves.toBeUndefined();
    expect(requestAccessToken).not.toHaveBeenCalled();
  });

  it("requests and accepts only the contacts.readonly scope", async () => {
    const pending = requestGoogleContactsToken();

    expect(requestAccessToken).toHaveBeenCalledTimes(1);
    expect(capturedConfig).toMatchObject({
      client_id: "uat-client.apps.googleusercontent.com",
      scope: CONTACTS_SCOPE,
      include_granted_scopes: false,
    });

    capturedConfig?.callback({
      access_token: "contacts-token",
      scope: `  ${CONTACTS_SCOPE}  `,
    });
    await expect(pending).resolves.toBe("contacts-token");
  });

  it.each([
    ["a missing scope", undefined],
    ["an OpenID scope", `${CONTACTS_SCOPE} openid`],
    ["email and reordered scopes", `email  ${CONTACTS_SCOPE}`],
  ])("rejects a token with %s", async (_label, scope) => {
    const pending = requestGoogleContactsToken();
    capturedConfig?.callback({ access_token: "broader-token", scope });

    await expect(pending).rejects.toThrow(/exact contacts-only scope/i);
  });

  it("removes a failed GIS tag and injects a fresh tag on retry", async () => {
    Reflect.deleteProperty(globalThis, "google");
    const preExistingScript = document.createElement("script");
    preExistingScript.src = "https://accounts.google.com/gsi/client";
    preExistingScript.setAttribute(
      "data-hushh-google-contacts-loader",
      "loading",
    );
    document.head.appendChild(preExistingScript);

    const firstLoad = preloadGoogleContactsAuth();
    const firstScript = document.querySelector<HTMLScriptElement>(
      'script[src="https://accounts.google.com/gsi/client"]',
    );
    expect(firstScript).toBe(preExistingScript);
    firstScript?.dispatchEvent(new Event("error"));
    await expect(firstLoad).rejects.toThrow(/could not reach google sign-in/i);
    expect(firstScript?.isConnected).toBe(false);

    const secondLoad = preloadGoogleContactsAuth();
    const secondScript = document.querySelector<HTMLScriptElement>(
      'script[src="https://accounts.google.com/gsi/client"]',
    );
    expect(secondScript).not.toBeNull();
    expect(secondScript).not.toBe(firstScript);
    secondScript?.dispatchEvent(new Event("error"));
    await expect(secondLoad).rejects.toThrow(/could not reach google sign-in/i);
  });

  it("times out a stalled GIS load so a later tap can retry", async () => {
    vi.useFakeTimers();
    try {
      Reflect.deleteProperty(globalThis, "google");
      const stalledLoad = preloadGoogleContactsAuth();
      const stalledScript = document.querySelector<HTMLScriptElement>(
        'script[src="https://accounts.google.com/gsi/client"]',
      );
      const rejection = expect(stalledLoad).rejects.toThrow(
        /could not reach google sign-in/i,
      );

      await vi.advanceTimersByTimeAsync(15_000);
      await rejection;
      expect(stalledScript?.isConnected).toBe(false);

      const retry = preloadGoogleContactsAuth();
      const retryScript = document.querySelector<HTMLScriptElement>(
        'script[src="https://accounts.google.com/gsi/client"]',
      );
      expect(retryScript).not.toBeNull();
      expect(retryScript).not.toBe(stalledScript);
      retryScript?.dispatchEvent(new Event("error"));
      await expect(retry).rejects.toThrow(/could not reach google sign-in/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects an OAuth denial without accepting a token", async () => {
    const pending = requestGoogleContactsToken();
    capturedConfig?.callback({ error: "access_denied" });

    await expect(pending).rejects.toThrow(/was not granted/i);
  });

  it("times out missing callbacks and ignores the expired attempt after retry", async () => {
    vi.useFakeTimers();
    const first = requestGoogleContactsToken();
    const expired = capturedConfig;
    const rejection = expect(first).rejects.toThrow(/sign-in did not finish/i);
    await vi.advanceTimersByTimeAsync(GOOGLE_CONTACTS_AUTH_TIMEOUT_MS);
    await rejection;
    const retry = requestGoogleContactsToken();
    expired?.callback({ access_token: "stale-token", scope: CONTACTS_SCOPE });
    capturedConfig?.callback({
      access_token: "fresh-token",
      scope: CONTACTS_SCOPE,
    });
    await expect(retry).resolves.toBe("fresh-token");
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([true, false])(
    "aborts without consuming a late token (pre-aborted=%s)",
    async (preAborted) => {
      vi.useFakeTimers();
      const abort = new AbortController();
      if (preAborted) abort.abort();
      const pending = requestGoogleContactsToken(abort.signal);
      const rejection = expect(pending).rejects.toMatchObject({
        name: "AbortError",
      });
      abort.abort();
      capturedConfig?.callback({
        access_token: "late-token",
        scope: CONTACTS_SCOPE,
      });
      await rejection;
      expect(requestAccessToken).toHaveBeenCalledTimes(preAborted ? 0 : 1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("settles synchronous SDK failures and permits a new tap", async () => {
    vi.useFakeTimers();
    requestAccessToken.mockImplementationOnce(() => {
      throw new Error("SDK failed");
    });
    await expect(requestGoogleContactsToken()).rejects.toThrow(
      /Could not open Google sign-in/,
    );
    expect(vi.getTimerCount()).toBe(0);
    const retry = requestGoogleContactsToken();
    capturedConfig?.callback({
      access_token: "fresh-token",
      scope: CONTACTS_SCOPE,
    });
    await expect(retry).resolves.toBe("fresh-token");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("forces the account chooser only when asked, silently otherwise", async () => {
    const silent = requestGoogleContactsToken();
    expect(requestAccessToken).toHaveBeenLastCalledWith(undefined);
    capturedConfig?.callback({
      access_token: "silent-token",
      scope: CONTACTS_SCOPE,
    });
    await expect(silent).resolves.toBe("silent-token");

    const choosing = requestGoogleContactsToken(undefined, {
      forceAccountPicker: true,
    });
    expect(requestAccessToken).toHaveBeenLastCalledWith({
      prompt: "select_account",
    });
    capturedConfig?.callback({
      access_token: "chosen-token",
      scope: CONTACTS_SCOPE,
    });
    await expect(choosing).resolves.toBe("chosen-token");
  });

  it("treats only a closed popup as cancellation", async () => {
    const pending = requestGoogleContactsToken();
    capturedConfig?.error_callback?.({ type: "popup_closed" });

    const error = await pending.catch((failure: unknown) => failure);
    expect(isGoogleContactsConsentCancelled(error)).toBe(true);
    expect(error).toMatchObject({ name: "AbortError" });
  });

  it.each(["popup_failed_to_open", "unknown"])(
    "surfaces %s as a visible failure",
    async (type) => {
      const pending = requestGoogleContactsToken();
      capturedConfig?.error_callback?.({ type });

      const error = await pending.catch((failure: unknown) => failure);
      expect(isGoogleContactsConsentCancelled(error)).toBe(false);
      expect(error).toMatchObject({ name: "Error" });
      if (type === "popup_failed_to_open") {
        expect(error).toMatchObject({
          message: expect.stringMatching(/allow pop-ups/i),
        });
      }
    },
  );

  it.each([true, false])(
    "authenticates a signup when Contacts permission is granted=%s",
    async (contactsGranted) => {
      const pending = requestGoogleSignupToken({ includeContacts: true });
      expect(requestAccessToken).toHaveBeenCalledTimes(1);
      expect(requestAccessToken).toHaveBeenLastCalledWith({ prompt: "select_account" });
      expect(capturedConfig).toMatchObject({
        client_id: "firebase-auth-client.apps.googleusercontent.com",
        scope: `${SIGNUP_IDENTITY_SCOPE} ${CONTACTS_SCOPE}`,
        include_granted_scopes: false,
      });
      capturedConfig?.callback({
        access_token: "signup-token",
        // Google's short identity aliases describe the same narrow grant.
        scope: `profile openid email${contactsGranted ? ` ${CONTACTS_SCOPE}` : ""}`,
      });
      await expect(pending).resolves.toEqual({ accessToken: "signup-token", contactsGranted });
    },
  );

  it("keeps ordinary Google authentication free of a Contacts request", async () => {
    const pending = requestGoogleSignupToken();
    expect(capturedConfig?.scope).toBe(SIGNUP_IDENTITY_SCOPE);
    capturedConfig?.callback({ access_token: "identity-token", scope: SIGNUP_IDENTITY_SCOPE });
    await expect(pending).resolves.toEqual({ accessToken: "identity-token", contactsGranted: false });
  });

  it("does not substitute the Contacts OAuth client for a missing sign-in client", async () => {
    vi.stubEnv("NEXT_PUBLIC_GOOGLE_SIGN_IN_CLIENT_ID", "  ");
    expect(googleSignupConfigured()).toBe(false);
    await expect(requestGoogleSignupToken({ includeContacts: true })).rejects.toMatchObject({
      code: "auth/operation-not-supported-in-this-environment",
    });
    expect(requestAccessToken).not.toHaveBeenCalled();
  });

  it("preloads signup independently of a missing Contacts client", async () => {
    // A completed load intentionally stays cached for the document lifetime.
    // Isolate this SDK-success case from later tests that remove the global.
    vi.resetModules();
    const { preloadGoogleSignupAuth } = await import("../../auth/google-signup-token");
    vi.stubEnv("NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID", "");
    const sharedGis = (globalThis as Record<string, unknown>).google;
    Reflect.deleteProperty(globalThis, "google");
    const loading = preloadGoogleSignupAuth();
    const script = document.querySelector<HTMLScriptElement>('script[src="https://accounts.google.com/gsi/client"]');
    expect(googleSignupConfigured()).toBe(true);
    expect(script).not.toBeNull();
    (globalThis as Record<string, unknown>).google = sharedGis;
    script?.dispatchEvent(new Event("load"));
    await expect(loading).resolves.toBeUndefined();
    expect(requestAccessToken).not.toHaveBeenCalled();
  });

  it.each([
    ["no identity scopes", CONTACTS_SCOPE],
    ["a missing identity scope", "openid email"],
    ["an accumulated write grant", `${SIGNUP_IDENTITY_SCOPE} ${CONTACTS_SCOPE} https://www.googleapis.com/auth/calendar.events`],
    ["missing confirmed scopes", undefined],
  ])("rejects signup credentials with %s", async (_label, scope) => {
    const pending = requestGoogleSignupToken({ includeContacts: true });
    capturedConfig?.callback({ access_token: "unconfirmed-token", scope });
    await expect(pending).rejects.toMatchObject({ code: "auth/invalid-credential" });
  });

  it("rejects unrequested Contacts access on an ordinary authentication", async () => {
    const pending = requestGoogleSignupToken({ includeContacts: false });
    capturedConfig?.callback({ access_token: "broader-token", scope: `${SIGNUP_IDENTITY_SCOPE} ${CONTACTS_SCOPE}` });
    await expect(pending).rejects.toMatchObject({ code: "auth/invalid-credential" });
  });

  it.each([true, false])(
    "does not consume a signup grant after cancellation (pre-aborted=%s)",
    async (preAborted) => {
      vi.useFakeTimers();
      const controller = new AbortController();
      if (preAborted) controller.abort();
      const pending = requestGoogleSignupToken({ includeContacts: true, signal: controller.signal });
      const rejection = expect(pending).rejects.toMatchObject({ name: "AbortError" });
      controller.abort();
      capturedConfig?.callback({ access_token: "late-token", scope: `${SIGNUP_IDENTITY_SCOPE} ${CONTACTS_SCOPE}` });
      await rejection;
      expect(requestAccessToken).toHaveBeenCalledTimes(preAborted ? 0 : 1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("times out a signup attempt and ignores its late callback during retry", async () => {
    vi.useFakeTimers();
    const first = requestGoogleSignupToken({ includeContacts: true });
    const expired = capturedConfig;
    const rejected = expect(first).rejects.toMatchObject({ code: "auth/timeout" });
    await vi.advanceTimersByTimeAsync(GOOGLE_SIGNUP_AUTH_TIMEOUT_MS);
    await rejected;
    const retry = requestGoogleSignupToken({ includeContacts: true });
    expired?.callback({ access_token: "expired-token", scope: `${SIGNUP_IDENTITY_SCOPE} ${CONTACTS_SCOPE}` });
    capturedConfig?.callback({ access_token: "fresh-token", scope: `${SIGNUP_IDENTITY_SCOPE} ${CONTACTS_SCOPE}` });
    await expect(retry).resolves.toEqual({ accessToken: "fresh-token", contactsGranted: true });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ["popup_closed", "auth/popup-closed-by-user"],
    ["popup_failed_to_open", "auth/popup-blocked"],
    ["unknown", "auth/internal-error"],
  ])("maps signup %s to an actionable authentication error", async (type, code) => {
    const pending = requestGoogleSignupToken();
    capturedConfig?.error_callback?.({ type });
    await expect(pending).rejects.toMatchObject({ code });
  });

  it("does not open signup after asynchronously warming a cold GIS client", async () => {
    Reflect.deleteProperty(globalThis, "google");
    await expect(requestGoogleSignupToken()).rejects.toMatchObject({ code: "auth/initialization-not-ready" });
    expect(requestAccessToken).not.toHaveBeenCalled();
    const script = document.querySelector<HTMLScriptElement>('script[src="https://accounts.google.com/gsi/client"]');
    expect(script).not.toBeNull();
    script?.dispatchEvent(new Event("error"));
    await Promise.resolve();
  });

  it("settles a synchronous signup SDK error and clears its timeout", async () => {
    vi.useFakeTimers();
    requestAccessToken.mockImplementationOnce(() => { throw new Error("SDK failure"); });
    await expect(requestGoogleSignupToken()).rejects.toMatchObject({ code: "auth/internal-error" });
    expect(vi.getTimerCount()).toBe(0);
  });
});
