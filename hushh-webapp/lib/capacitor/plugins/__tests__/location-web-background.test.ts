import { afterEach, describe, expect, it, vi } from "vitest";
import { HushhLocationWeb } from "@/lib/capacitor/plugins/location-web";

describe("HushhLocationWeb background sharing", () => {
  it("reports background sharing as unsupported on web", async () => {
    const web = new HushhLocationWeb();
    const result = await web.startBackgroundShare({
      vaultOwnerToken: "t",
      backendBaseUrl: "https://api.example.com",
      grants: [],
      minMoveMeters: 25,
      minIntervalMs: 8000,
    });
    expect(result).toEqual({ started: false, reason: "unsupported-on-web" });
  });

  it("stopBackgroundShare resolves as a no-op on web", async () => {
    const web = new HushhLocationWeb();
    await expect(web.stopBackgroundShare()).resolves.toBeUndefined();
  });
});

describe("HushhLocationWeb.getPermissionState", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports prompt when the browser cannot answer the query", async () => {
    // Safari/WebKit has no `geolocation` entry in the Permissions API, so this
    // rejects on every iPhone. An unguarded await used to surface as
    // `unavailable`, which blocked every share path and pinned the Location
    // toggle off on a device whose location worked perfectly.
    vi.stubGlobal("navigator", {
      geolocation: { getCurrentPosition: vi.fn(), watchPosition: vi.fn(), clearWatch: vi.fn() },
      permissions: {
        query: vi.fn().mockRejectedValue(new TypeError("GeolocationPermissionDescriptor")),
      },
    });

    const state = await new HushhLocationWeb().getPermissionState();

    expect(state.state).toBe("prompt");
    expect(state.locationServicesEnabled).not.toBe(false);
  });

  it("reports prompt when the Permissions API is absent entirely", async () => {
    vi.stubGlobal("navigator", {
      geolocation: { getCurrentPosition: vi.fn(), watchPosition: vi.fn(), clearWatch: vi.fn() },
    });

    expect((await new HushhLocationWeb().getPermissionState()).state).toBe("prompt");
  });

  it("passes a real answer through untouched", async () => {
    vi.stubGlobal("navigator", {
      geolocation: { getCurrentPosition: vi.fn(), watchPosition: vi.fn(), clearWatch: vi.fn() },
      permissions: { query: vi.fn().mockResolvedValue({ state: "granted" }) },
    });

    expect((await new HushhLocationWeb().getPermissionState()).state).toBe("granted");
  });

  it("reports unavailable only when the device truly has no geolocation", async () => {
    vi.stubGlobal("navigator", {});

    const state = await new HushhLocationWeb().getPermissionState();

    expect(state.state).toBe("unavailable");
    expect(state.locationServicesEnabled).toBe(false);
  });
});
