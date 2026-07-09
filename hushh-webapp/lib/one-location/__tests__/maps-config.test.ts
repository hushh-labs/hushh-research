import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getBrowserMapsApiKey,
  isBrowserMapsConfigured,
} from "@/lib/one-location/maps-config";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("maps-config", () => {
  it("reports not configured when the env var is empty", () => {
    vi.stubEnv("NEXT_PUBLIC_GOOGLE_MAPS_API_KEY", "");
    expect(isBrowserMapsConfigured()).toBe(false);
    expect(getBrowserMapsApiKey()).toBe("");
  });

  it("trims and returns the key when present", () => {
    vi.stubEnv("NEXT_PUBLIC_GOOGLE_MAPS_API_KEY", "  browser-key  ");
    expect(getBrowserMapsApiKey()).toBe("browser-key");
    expect(isBrowserMapsConfigured()).toBe(true);
  });
});
