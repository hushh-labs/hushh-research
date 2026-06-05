import { beforeEach, describe, expect, it, vi } from "vitest";

// Capacitor mock is required because client.ts (imported below for pure
// utility functions) calls Capacitor.isNativePlatform() at module level.
vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => false, getPlatform: () => "web" },
}));

import {
  resolveAnalyticsMeasurementId,
  resolveGtmContainerId,
  shouldLoadWebAnalyticsScripts,
} from "@/lib/observability/env";
import { webGtmAdapter } from "@/lib/observability/adapters/web-gtm";
import {
  toDurationBucket,
  toEventResult,
  toStatusBucket,
} from "@/lib/observability/client";

declare global {
  interface Window {
    dataLayer?: Array<Record<string, unknown>>;
    gtag?: ReturnType<typeof vi.fn>;
  }
}

describe("web observability transport", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    window.dataLayer = [];
    window.gtag = vi.fn();
  });

  it("ignores placeholder GTM and measurement IDs", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "uat");
    vi.stubEnv("NEXT_PUBLIC_GTM_ID", "GTM-UATPENDING1");
    vi.stubEnv("NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID", "replace_with_uat_measurement_id");

    expect(resolveGtmContainerId()).toBe("");
    expect(resolveAnalyticsMeasurementId()).toBe("");
  });

  it("does not load remote analytics scripts during next dev by default", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID", "G-H1KGXGZTCF");

    expect(shouldLoadWebAnalyticsScripts()).toBe(false);

    vi.stubEnv("NEXT_PUBLIC_OBSERVABILITY_LOAD_IN_DEV", "1");
    expect(shouldLoadWebAnalyticsScripts()).toBe(true);
  });

  it("uses direct gtag delivery when GTM is not configured", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "uat");
    vi.stubEnv("NEXT_PUBLIC_GTM_ID", "GTM-UATPENDING1");
    vi.stubEnv("NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID", "G-H1KGXGZTCF");

    await webGtmAdapter.track("growth_funnel_step_completed", {
      env: "uat",
      platform: "web",
      event_category: "funnel",
      journey: "investor",
      step: "entered",
      app_version: "2.1.0",
    });

    expect(window.dataLayer).toEqual([
      {
        event: "growth_funnel_step_completed",
        event_source: "observability_v2",
        env: "uat",
        platform: "web",
        event_category: "funnel",
        journey: "investor",
        step: "entered",
        app_version: "2.1.0",
      },
    ]);
    expect(window.gtag).toHaveBeenCalledTimes(1);
    expect(window.gtag).toHaveBeenCalledWith(
      "event",
      "growth_funnel_step_completed",
      {
        send_to: "G-H1KGXGZTCF",
        event_source: "observability_v2",
        env: "uat",
        platform: "web",
        event_category: "funnel",
        journey: "investor",
        step: "entered",
        app_version: "2.1.0",
      }
    );
  });

  it("pushes to GTM and still sends direct GA4 when a real container is configured", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_GTM_ID", "GTM-ABC1234");
    vi.stubEnv("NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID", "G-2PCECPSKCR");

    await webGtmAdapter.track("investor_activation_completed", {
      env: "production",
      platform: "web",
      event_category: "funnel",
      journey: "investor",
      portfolio_source: "statement",
      app_version: "2.1.0",
    });

    expect(window.dataLayer).toEqual([
      {
        event: "investor_activation_completed",
        event_source: "observability_v2",
        env: "production",
        platform: "web",
        event_category: "funnel",
        journey: "investor",
        portfolio_source: "statement",
        app_version: "2.1.0",
      },
    ]);
    expect(window.gtag).toHaveBeenCalledTimes(1);
    expect(window.gtag).toHaveBeenCalledWith(
      "event",
      "investor_activation_completed",
      {
        send_to: "G-2PCECPSKCR",
        event_source: "observability_v2",
        env: "production",
        platform: "web",
        event_category: "funnel",
        journey: "investor",
        portfolio_source: "statement",
        app_version: "2.1.0",
      }
    );
  });
});

// ── Metrics exporter — backend timeout fallback ───────────────────────────────
//
// The observability export pipeline is a two-layer stack:
//   1. Pure utility layer — toDurationBucket / toStatusBucket / toEventResult:
//      classify timeout-range metrics without I/O or side-effects.
//   2. Transport layer — webGtmAdapter.track():
//      always writes a local dataLayer frame before attempting remote gtag
//      delivery; a throwing or absent gtag must never block the thread.
//
// Timeout contracts under test:
//   A. null status code (dropped connection) → "network_error" bucket, never
//      silently promoted to a 4xx_expected category.
//   B. >= 10 s duration → "gte_10s" bucket; hard gateway timeouts are
//      classified, not silently swallowed.
//   C. "network_error" → EventResult "error", never "success" or "expected_error".
//   D. webGtmAdapter.track() resolves when the remote delivery channel is
//      unavailable; the local dataLayer frame is preserved.
//   E. webGtmAdapter.track() yields a catchable rejection (never unhandled) when
//      the gtag sink throws a gateway-timeout error synchronously.
//   F. Burst of concurrent timeout events all queue to dataLayer; the thread
//      never hangs regardless of delivery channel state.

describe("metrics exporter — backend timeout fallback", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    window.dataLayer = [];
    window.gtag = vi.fn();
  });

  // ── A: null status → network_error (connection drop / hard timeout) ───────

  it("maps a null status code to the network_error bucket for any HTTP method", () => {
    expect(toStatusBucket(null, "GET", "/api/pkm/metadata/{user_id}")).toBe("network_error");
    expect(toStatusBucket(null, "POST", "/api/kai/analyze/run/start")).toBe("network_error");
    expect(toStatusBucket(null, "DELETE", "/api/account/delete")).toBe("network_error");
  });

  it("never promotes a null status to 4xx_expected even for endpoints with known error codes", () => {
    // These endpoints have expected 4xx codes, but a dropped connection is
    // always network_error — the expected-error gate only applies to real status codes.
    const expectedErrorEndpoints: Array<[string, string]> = [
      ["GET",  "/api/kai/analyze/run/active"],
      ["POST", "/api/kai/analyze/run/start"],
      ["GET",  "/api/pkm/metadata/{user_id}"],
      ["POST", "/db/vault/get"],
      ["POST", "/db/vault/bootstrap-state"],
    ];

    for (const [method, template] of expectedErrorEndpoints) {
      const bucket = toStatusBucket(null, method, template);
      expect(bucket).toBe("network_error");
      expect(bucket).not.toBe("4xx_expected");
    }
  });

  // ── B: timeout durations → gte_10s bucket ────────────────────────────────

  it("classifies hard gateway-timeout durations into the gte_10s duration bucket", () => {
    expect(toDurationBucket(10_000)).toBe("gte_10s"); // exactly 10 s
    expect(toDurationBucket(30_000)).toBe("gte_10s"); // 30 s hard gateway timeout
    expect(toDurationBucket(60_000)).toBe("gte_10s"); // 60 s extreme timeout
    expect(toDurationBucket(9_999)).toBe("3s_10s");   // just below threshold
  });

  // ── C: network_error → EventResult "error" ────────────────────────────────

  it("escalates network_error to the error EventResult — never success or expected_error", () => {
    const result = toEventResult("network_error");
    expect(result).toBe("error");
    expect(result).not.toBe("success");
    expect(result).not.toBe("expected_error");
  });

  // ── D: adapter resolves cleanly when the remote delivery channel is down ──

  it("resolves without throwing when the gtag delivery channel is unavailable", async () => {
    // Simulate: gtag not injected (delivery endpoint unreachable / timed out)
    window.gtag = undefined as unknown as typeof window.gtag;
    vi.stubEnv("NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID", "G-TIMEOUTTEST1");

    await expect(
      webGtmAdapter.track("api_request_completed", {
        env: "uat",
        platform: "web",
        event_category: "system",
        app_version: "1.0.0",
        result: "error",
        status_bucket: "network_error",
        duration_ms_bucket: "gte_10s",
      })
    ).resolves.toBeUndefined();
  });

  it("still writes the frame to dataLayer before the gtag call even when gtag is absent", async () => {
    window.dataLayer = [];
    window.gtag = undefined as unknown as typeof window.gtag;
    vi.stubEnv("NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID", "G-TIMEOUTTEST2");

    await webGtmAdapter.track("api_request_completed", {
      env: "uat",
      platform: "web",
      event_category: "system",
      app_version: "1.0.0",
      result: "error",
      status_bucket: "network_error",
      duration_ms_bucket: "gte_10s",
    });

    expect(window.dataLayer).toHaveLength(1);
    expect(window.dataLayer?.[0]).toMatchObject({
      event: "api_request_completed",
      event_source: "observability_v2",
      status_bucket: "network_error",
      duration_ms_bucket: "gte_10s",
    });
  });

  // ── E: adapter rejects catchably when gtag throws a gateway-timeout error ─

  it("yields a catchable rejection — not an unhandled throw — when gtag fires a synchronous timeout error", async () => {
    window.gtag = vi.fn().mockImplementation(() => {
      throw new TypeError("Failed to fetch: 504 gateway timeout");
    });
    vi.stubEnv("NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID", "G-TIMEOUTTEST3");

    const promise = webGtmAdapter.track("api_request_completed", {
      env: "uat",
      platform: "web",
      event_category: "system",
      app_version: "1.0.0",
      result: "error",
      status_bucket: "network_error",
      duration_ms_bucket: "gte_10s",
    });

    // Rejection must be a Promise rejection (catchable), never an unhandled throw
    await expect(promise).rejects.toThrow("504 gateway timeout");
  });

  it("preserves the dataLayer frame before the gtag call even when gtag throws a timeout error", async () => {
    window.dataLayer = [];
    window.gtag = vi.fn().mockImplementation(() => {
      throw new TypeError("Failed to fetch: 504 gateway timeout");
    });
    vi.stubEnv("NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID", "G-TIMEOUTTEST4");

    // Swallow the expected rejection from gtag
    try {
      await webGtmAdapter.track("api_request_completed", {
        env: "uat",
        platform: "web",
        event_category: "system",
        app_version: "1.0.0",
        result: "error",
        status_bucket: "network_error",
        duration_ms_bucket: "gte_10s",
      });
    } catch { /* expected — gtag threw */ }

    // The local dataLayer write happens before gtag — the frame is never lost
    expect(window.dataLayer).toHaveLength(1);
    expect(window.dataLayer?.[0]).toMatchObject({
      event: "api_request_completed",
      event_source: "observability_v2",
      result: "error",
      status_bucket: "network_error",
      duration_ms_bucket: "gte_10s",
    });
  });

  // ── F: burst of timeout events — thread never hangs ──────────────────────

  it("queues all frames to dataLayer for a burst of 10 concurrent timeout events without blocking", async () => {
    window.dataLayer = [];
    // No gtag delivery — simulates backend timeout / unreachable endpoint
    window.gtag = undefined as unknown as typeof window.gtag;

    const BURST = 10;
    const promises = Array.from({ length: BURST }, () =>
      webGtmAdapter.track("api_request_completed", {
        env: "uat",
        platform: "web",
        event_category: "system",
        app_version: "1.0.0",
        result: "error",
        status_bucket: "network_error",
        duration_ms_bucket: "gte_10s",
      })
    );

    // Promise.allSettled must resolve — none may hang
    const results = await Promise.allSettled(promises);
    const statuses = results.map((r) => r.status);
    expect(statuses.every((s) => s === "fulfilled")).toBe(true);

    // All frames locally buffered despite no active delivery channel
    expect(window.dataLayer).toHaveLength(BURST);
    for (const frame of window.dataLayer ?? []) {
      expect(frame.status_bucket).toBe("network_error");
      expect(frame.duration_ms_bucket).toBe("gte_10s");
    }
  });
});
