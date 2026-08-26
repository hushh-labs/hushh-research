import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  isGoogleContactsConsentCancelled,
  preloadGoogleContactsAuth,
  requestGoogleContactsToken,
} from "../google-contacts-token";

const CONTACTS_SCOPE =
  "https://www.googleapis.com/auth/contacts.readonly";

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
});
