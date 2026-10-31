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
import { subscribeTrackedEvents } from "@/lib/observability/tracked-event-bus";

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

  it("rejects the entire event when a required governed enum is missing", () => {
    const handedOff = trackEvent("one_memory_action", {
      route_id: "pkm",
      result: "success",
    } as never);

    expect(handedOff).toBe(false);
    expect(adapters.webTrack).not.toHaveBeenCalled();
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

  it("taps only sanitized, non-fatal events and isolates analytics from a failing listener", () => {
    const received: Array<[string, Readonly<Record<string, unknown>>]> = [];
    const stopThrowing = subscribeTrackedEvents((_name, sanitized) => {
      (sanitized as Record<string, unknown>).action = "tampered";
    });
    const stopRecording = subscribeTrackedEvents((name, sanitized) => { received.push([name, sanitized]); });
    try {
      expect(trackEvent("one_memory_action", {
        route_id: "pkm", action: "undeclared_dynamic_action", result: "success",
      } as never)).toBe(false);
      expect(received).toEqual([]);

      const handedOff = trackEvent("one_memory_action", {
        route_id: "pkm", action: "capture_saved", result: "success", email: "must-not-leave@example.test",
      } as never);

      expect(handedOff).toBe(true);
      expect(received).toHaveLength(1);
      expect(received[0]?.[1]).toMatchObject({ action: "capture_saved", result: "success" });
      expect(received[0]?.[1]).not.toHaveProperty("email");
      expect(adapters.webTrack.mock.calls[0]?.[1]).toMatchObject({ action: "capture_saved" });
    } finally {
      stopThrowing();
      stopRecording();
    }
  });
});
