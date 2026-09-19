// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const capacitor = vi.hoisted(() => ({ native: false, preference: null as string | null }));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => capacitor.native,
    getPlatform: () => (capacitor.native ? "ios" : "web"),
  },
}));

vi.mock("@capacitor/preferences", () => ({
  Preferences: {
    get: async () => ({ value: capacitor.preference }),
  },
}));

import {
  PERF_HUD_SESSION_KEY,
  PERF_PROBE_SESSION_KEY,
  resolvePerfProbeEnablement,
  resolvePerfProbeEnablementSync,
} from "@/lib/perf/perf-probe-enablement";

function setSearch(search: string) {
  window.history.replaceState(null, "", `/one${search}`);
}

describe("perf probe enablement", () => {
  beforeEach(() => {
    capacitor.native = false;
    capacitor.preference = null;
    window.sessionStorage.clear();
    setSearch("");
  });

  afterEach(() => {
    window.sessionStorage.clear();
  });

  it("is inert with no signal", async () => {
    expect(resolvePerfProbeEnablementSync()).toEqual({
      enabled: false,
      hud: false,
      source: "none",
    });
    await expect(resolvePerfProbeEnablement()).resolves.toMatchObject({ enabled: false });
  });

  it("turns on from ?perf=1 and remembers it for the session", () => {
    setSearch("?perf=1");
    expect(resolvePerfProbeEnablementSync()).toEqual({
      enabled: true,
      hud: false,
      source: "query",
    });
    setSearch("");
    expect(resolvePerfProbeEnablementSync()).toEqual({
      enabled: true,
      hud: false,
      source: "session",
    });
    expect(window.sessionStorage.getItem(PERF_PROBE_SESSION_KEY)).toBe("1");
    expect(window.sessionStorage.getItem(PERF_HUD_SESSION_KEY)).toBeNull();
  });

  it("turns on the HUD from ?perf=hud", () => {
    setSearch("?perf=hud");
    expect(resolvePerfProbeEnablementSync()).toMatchObject({ enabled: true, hud: true });
  });

  it("reads the native launch preference only inside the shell", async () => {
    capacitor.preference = "1";
    await expect(resolvePerfProbeEnablement()).resolves.toMatchObject({ enabled: false });

    capacitor.native = true;
    await expect(resolvePerfProbeEnablement()).resolves.toEqual({
      enabled: true,
      hud: false,
      source: "preferences",
    });
  });

  it("ignores any other preference value", async () => {
    capacitor.native = true;
    capacitor.preference = "yes";
    await expect(resolvePerfProbeEnablement()).resolves.toMatchObject({ enabled: false });
  });
});
