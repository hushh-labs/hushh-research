import { beforeEach, describe, expect, it, vi } from "vitest";

const adapters = vi.hoisted(() => ({
  webTrack: vi.fn().mockResolvedValue(undefined),
  nativeTrack: vi.fn().mockResolvedValue(undefined),
  platform: "web" as "web" | "ios" | "android",
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => adapters.platform !== "web",
    getPlatform: () => adapters.platform,
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
    isAvailable: () => adapters.platform === "web",
    track: adapters.webTrack,
  },
}));

vi.mock("@/lib/observability/adapters/native-firebase", () => ({
  nativeFirebaseAdapter: {
    name: "native-firebase",
    isAvailable: () => adapters.platform !== "web",
    track: adapters.nativeTrack,
  },
}));

import { trackEvent } from "@/lib/observability/client";
import { subscribeTrackedEvents } from "@/lib/observability/tracked-event-bus";
import { deriveOneFeatureDimensions } from "@/lib/observability/one-feature-dimensions";
import { ONE_CAREER_ACTIONS, ONE_DOCUMENT_REQUEST_ACTIONS } from "@/lib/observability/actions";

describe("governed observability dispatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    adapters.platform = "web";
  });

  it.each(["web", "ios", "android"] as const)("derives reviewed dimensions for %s and discards supplied aliases", (platform) => {
    adapters.platform = platform;
    expect(trackEvent("one_memory_action", {
      route_id: "pkm", action: "detail_edited", result: "error",
      one_feature_action: "forged", one_feature_result: "success",
    } as never)).toBe(true);
    const receiver = platform === "web" ? adapters.webTrack : adapters.nativeTrack;
    const other = platform === "web" ? adapters.nativeTrack : adapters.webTrack;
    expect(receiver).toHaveBeenCalledWith("one_memory_action", expect.objectContaining({
      action: "detail_edited", result: "error",
      one_feature_action: "detail_edited", one_feature_result: "error",
    }));
    expect(other).not.toHaveBeenCalled();
  });

  it("never forwards supplied aliases on unrelated events", () => {
    expect(trackEvent("auth_succeeded", {
      action: "google", result: "success", one_feature_action: "capture_saved", one_feature_result: "success",
    } as never)).toBe(true);
    const payload = adapters.webTrack.mock.calls[0]?.[1];
    expect(payload).toMatchObject({ action: "google", result: "success" });
    expect(payload).not.toHaveProperty("one_feature_action");
    expect(payload).not.toHaveProperty("one_feature_result");
  });

  it("withholds both aliases for unreviewed action/result values while preserving prior raw behavior", () => {
    // The raw Consent fields have no runtime enum gate today. A dedicated
    // alias must not make that permissive legacy contract reportable as One.
    expect(trackEvent("consent_action_result", { action: "unreviewed", result: "success" } as never)).toBe(true);
    const payload = adapters.webTrack.mock.calls[0]?.[1];
    expect(payload).toMatchObject({ action: "unreviewed", result: "success" });
    expect(payload).not.toHaveProperty("one_feature_action");
    expect(payload).not.toHaveProperty("one_feature_result");
    expect(deriveOneFeatureDimensions("consent_action_result", { action: "deny", result: "unreviewed" })).toEqual({});
    expect(deriveOneFeatureDimensions("one_location_journey_action", { action: "circle_opened" })).toEqual({});
  });

  it("derives only declared feature stages and keeps failures distinct from successful outcomes", () => {
    expect(deriveOneFeatureDimensions("consent_action_result", { action: "deny", result: "expected_error" }))
      .toEqual({ one_feature_action: "deny", one_feature_result: "expected_error" });
    expect(deriveOneFeatureDimensions("gmail_sync_result", { action: "queue", result: "success" }))
      .toEqual({ one_feature_action: "queue", one_feature_result: "success" });
    expect(deriveOneFeatureDimensions("one_location_journey_action", { action: "location_request_fulfilled", result: "error" }))
      .toEqual({ one_feature_action: "location_request_fulfilled", one_feature_result: "error" });
    expect(deriveOneFeatureDimensions("import_parse_completed", { result: "error" }))
      .toEqual({ one_feature_result: "error" });
    expect(deriveOneFeatureDimensions("analysis_stream_started", { result: "success" }))
      .toEqual({ one_feature_result: "success" });
    expect(deriveOneFeatureDimensions("analysis_stream_started", { result: "error" })).toEqual({});
    expect(deriveOneFeatureDimensions("one_crm_action", { action: "record_created", result: "success" })).toEqual({});
    expect(deriveOneFeatureDimensions("consent_pending_loaded", { result: "success", load_surface: "warm" })).toEqual({});
  });

  it("routes only finite Career/Documents operation metadata on the actual Main adapter", () => {
    for (const [event, actions] of [["one_career_action", ONE_CAREER_ACTIONS], ["one_document_request_action", ONE_DOCUMENT_REQUEST_ACTIONS]] as const) {
      for (const action of actions) {
        for (const result of ["success", "error"] as const) {
          expect(trackEvent(event, { action, result, filename: "PRIVATE.pdf", query: "PRIVATE_CONTENT", owner_id: "PRIVATE_OWNER" } as never)).toBe(true);
          expect(adapters.webTrack).toHaveBeenLastCalledWith(event, expect.objectContaining({ action, result }));
          for (const key of ["filename", "query", "owner_id"]) expect(adapters.webTrack.mock.lastCall?.[1]).not.toHaveProperty(key);
        }
      }
      const calls = adapters.webTrack.mock.calls.length;
      for (const payload of [{ action: "PRIVATE_ROLE_ID", result: "success" }, { result: "success" }, { action: actions[0], result: "sent-to-person" }]) expect(trackEvent(event, payload as never)).toBe(false);
      expect(adapters.webTrack).toHaveBeenCalledTimes(calls);
    }
    expect(adapters.webTrack).toHaveBeenCalledTimes(12);
    expect(adapters.nativeTrack).not.toHaveBeenCalled();
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
