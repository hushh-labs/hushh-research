import { beforeEach, describe, expect, it, vi } from "vitest";

const adapters = vi.hoisted(() => ({
  webTrack: vi.fn().mockResolvedValue(undefined),
  nativeTrack: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => false,
    getPlatform: () => "web",
  },
}));

vi.mock("@/lib/observability/env", () => ({
  isObservabilityDebugEnabled: () => false,
  isObservabilityEnabled: () => true,
  resolveObservabilityEnvironment: () => "uat",
  resolveObservabilitySampleRate: () => 1,
}));

vi.mock("@/lib/observability/client-version", () => ({
  resolveClientVersion: () => "test",
}));

vi.mock("@/lib/observability/adapters/web-gtm", () => ({
  webGtmAdapter: {
    name: "web-gtm",
    isAvailable: () => true,
    track: adapters.webTrack,
  },
}));

vi.mock("@/lib/observability/adapters/native-firebase", () => ({
  nativeFirebaseAdapter: {
    name: "native-firebase",
    isAvailable: () => false,
    track: adapters.nativeTrack,
  },
}));

import { trackEvent } from "@/lib/observability/client";

describe("governed observability dispatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects the entire event when a governed enum is undeclared", () => {
    const handedOff = trackEvent("one_memory_action", {
      route_id: "pkm",
      action: "undeclared_dynamic_action",
      result: "success",
    } as never);

    expect(handedOff).toBe(false);
    expect(adapters.webTrack).not.toHaveBeenCalled();
    expect(adapters.nativeTrack).not.toHaveBeenCalled();
  });

  it("still sanitizes non-governed extra fields without dropping a valid event", () => {
    const handedOff = trackEvent("one_memory_action", {
      route_id: "pkm",
      action: "detail_edited",
      result: "success",
      email: "must-not-leave@example.test",
    } as never);

    expect(handedOff).toBe(true);
    expect(adapters.webTrack).toHaveBeenCalledWith(
      "one_memory_action",
      expect.objectContaining({
        route_id: "pkm",
        action: "detail_edited",
        result: "success",
      }),
    );
    expect(adapters.webTrack.mock.calls[0]?.[1]).not.toHaveProperty("email");
  });
});
