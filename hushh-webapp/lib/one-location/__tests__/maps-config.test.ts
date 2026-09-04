import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getBrowserMapsApiKey,
  getNativeMapsApiKey,
  isBrowserMapsConfigured,
} from "@/lib/one-location/maps-config";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("maps-config", () => {
  it("reports not configured when the env var is empty", () => {
    vi.stubEnv("NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_API_KEY", "");
    vi.stubEnv("NEXT_PUBLIC_GOOGLE_MAPS_API_KEY", "");
    expect(isBrowserMapsConfigured()).toBe(false);
    expect(getBrowserMapsApiKey()).toBe("");
  });

  it("trims and returns the key when present", () => {
    vi.stubEnv("NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_API_KEY", "  browser-key  ");
    expect(getBrowserMapsApiKey()).toBe("browser-key");
    expect(isBrowserMapsConfigured()).toBe(true);
  });

  it("keeps the legacy browser key as a compatibility fallback", () => {
    vi.stubEnv("NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_API_KEY", "");
    vi.stubEnv("NEXT_PUBLIC_GOOGLE_MAPS_API_KEY", "  legacy-browser-key  ");
    expect(getBrowserMapsApiKey()).toBe("legacy-browser-key");
  });

  it("selects only the platform-specific native SDK key", () => {
    vi.stubEnv("NEXT_PUBLIC_GOOGLE_MAPS_IOS_API_KEY", " ios-sdk-key ");
    vi.stubEnv("NEXT_PUBLIC_GOOGLE_MAPS_ANDROID_API_KEY", " android-sdk-key ");

    expect(getNativeMapsApiKey("ios")).toBe("ios-sdk-key");
    expect(getNativeMapsApiKey("android")).toBe("android-sdk-key");
  });
});
