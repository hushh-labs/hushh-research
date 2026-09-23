import { beforeEach, describe, expect, it, vi } from "vitest";

const capacitorState = vi.hoisted(() => ({
  platform: "web" as "web" | "ios" | "android",
  pluginAvailable: false,
  nativeAvailable: true,
}));

const apiFetch = vi.hoisted(() => vi.fn());

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    getPlatform: () => capacitorState.platform,
    isNativePlatform: () => capacitorState.platform !== "web",
    isPluginAvailable: (name: string) =>
      name === "HushhPlaidLink" && capacitorState.pluginAvailable,
  },
  registerPlugin: () => ({
    isAvailable: vi.fn(async () => ({ available: capacitorState.nativeAvailable })),
    open: vi.fn(),
    addListener: vi.fn(),
  }),
}));

vi.mock("@/lib/services/api-service", () => ({
  ApiService: { apiFetch },
}));

vi.mock("@/lib/services/auth-service", () => ({
  AuthService: { getIdToken: vi.fn(async () => "firebase-id-token") },
}));

vi.mock("@/lib/cache/cache-sync-service", () => ({
  CacheSyncService: {},
}));

import {
  resetNativePlaidLinkAvailabilityForTests,
  resolvePlaidLinkPlatform,
} from "@/lib/capacitor/plaid-link";
import { PlaidPortfolioService } from "@/lib/kai/brokerage/plaid-portfolio-service";

const REDIRECT_URI = "https://uat.one.hushh.ai/one/kai/plaid/oauth/return";

function setShell(
  platform: "web" | "ios" | "android",
  { pluginAvailable = platform !== "web", nativeAvailable = true } = {},
) {
  capacitorState.platform = platform;
  capacitorState.pluginAvailable = pluginAvailable;
  capacitorState.nativeAvailable = nativeAvailable;
  resetNativePlaidLinkAvailabilityForTests();
}

function lastRequestBody(): Record<string, unknown> {
  const [, init] = apiFetch.mock.calls.at(-1) as [string, RequestInit];
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

beforeEach(() => {
  apiFetch.mockReset();
  apiFetch.mockImplementation(
    async () =>
      new Response(JSON.stringify({ configured: true, mode: "create", link_token: "link-test" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  );
});

describe("resolvePlaidLinkPlatform", () => {
  it("is web in a browser", async () => {
    setShell("web");
    await expect(resolvePlaidLinkPlatform()).resolves.toBe("web");
  });

  it("is ios on the iOS shell", async () => {
    setShell("ios");
    await expect(resolvePlaidLinkPlatform()).resolves.toBe("ios");
  });

  it("is android only when the native SDK will open the token", async () => {
    setShell("android");
    await expect(resolvePlaidLinkPlatform()).resolves.toBe("android");
  });

  it("falls back to web on Android without the plugin (web Link runs)", async () => {
    setShell("android", { pluginAvailable: false });
    await expect(resolvePlaidLinkPlatform()).resolves.toBe("web");
  });

  it("falls back to web on an Android device the SDK does not support", async () => {
    setShell("android", { nativeAvailable: false });
    await expect(resolvePlaidLinkPlatform()).resolves.toBe("web");
  });
});

describe("PlaidPortfolioService link-token requests", () => {
  it("keeps the redirect URI and reports web in a browser", async () => {
    setShell("web");
    await PlaidPortfolioService.createLinkToken({
      userId: "user-1",
      vaultOwnerToken: "vault-token",
      redirectUri: REDIRECT_URI,
    });

    expect(apiFetch.mock.calls[0]?.[0]).toBe("/api/kai/plaid/link-token");
    expect(lastRequestBody()).toMatchObject({ platform: "web", redirect_uri: REDIRECT_URI });
  });

  it("keeps the redirect URI and reports ios on the iOS shell", async () => {
    setShell("ios");
    await PlaidPortfolioService.createLinkToken({
      userId: "user-1",
      vaultOwnerToken: "vault-token",
      redirectUri: REDIRECT_URI,
    });

    expect(lastRequestBody()).toMatchObject({ platform: "ios", redirect_uri: REDIRECT_URI });
  });

  it("drops the https redirect URI on native Android", async () => {
    setShell("android");
    await PlaidPortfolioService.createLinkToken({
      userId: "user-1",
      vaultOwnerToken: "vault-token",
      itemId: "item-1",
      updateMode: true,
      redirectUri: REDIRECT_URI,
    });

    expect(apiFetch.mock.calls[0]?.[0]).toBe("/api/kai/plaid/link-token/update");
    expect(lastRequestBody()).toMatchObject({ platform: "android", redirect_uri: null });
  });

  it("sends platform on the funding link-token request too", async () => {
    setShell("android");
    await PlaidPortfolioService.createFundingLinkToken({
      userId: "user-1",
      vaultOwnerToken: "vault-token",
      redirectUri: REDIRECT_URI,
    });

    expect(apiFetch.mock.calls[0]?.[0]).toBe("/api/kai/plaid/funding/link-token");
    expect(lastRequestBody()).toMatchObject({ platform: "android", redirect_uri: null });

    setShell("web");
    await PlaidPortfolioService.createFundingLinkToken({
      userId: "user-1",
      vaultOwnerToken: "vault-token",
      redirectUri: REDIRECT_URI,
    });
    expect(lastRequestBody()).toMatchObject({ platform: "web", redirect_uri: REDIRECT_URI });
  });
});
