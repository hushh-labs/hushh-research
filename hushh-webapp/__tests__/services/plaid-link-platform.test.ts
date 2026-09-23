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

function setShell(
  platform: "web" | "ios" | "android",
  { pluginAvailable = platform !== "web", nativeAvailable = true } = {},
) {
  capacitorState.platform = platform;
  capacitorState.pluginAvailable = pluginAvailable;
  capacitorState.nativeAvailable = nativeAvailable;
  resetNativePlaidLinkAvailabilityForTests();
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
