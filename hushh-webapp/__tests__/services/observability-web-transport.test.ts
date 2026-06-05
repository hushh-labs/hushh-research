import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  isObservabilityDebugEnabled,
  isObservabilityEnabled,
  resolveAnalyticsMeasurementId,
  resolveGtmContainerId,
  shouldLoadWebAnalyticsScripts,
} from "@/lib/observability/env";
import { webGtmAdapter } from "@/lib/observability/adapters/web-gtm";

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

// ── String-to-boolean coercion — fringe env string values ─────────────────────
//
// isObservabilityEnabled and isObservabilityDebugEnabled both pipe their env
// var through normalizeValue() which trims whitespace and lowercases before
// the final list comparison.  The tests below pin the exact coercion contract
// for strings that callers (env files, CI configs, platform secrets) are known
// to supply in non-canonical forms.
//
// Production module: lib/observability/env.ts
// Coercion logic:    normalizeValue(raw) = String(raw||"").trim().toLowerCase()
//
//   isObservabilityEnabled  → false only for {"0","false","no","off"}; everything
//                             else including empty/unset defaults to true.
//   isObservabilityDebugEnabled → true only for {"1","true","yes","on"}.

describe("string-to-boolean coercion — fringe env string values", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  // ── isObservabilityEnabled ─────────────────────────────────────────────────

  describe("isObservabilityEnabled", () => {
    // Falsy signals — the explicit opt-out list
    it.each([
      ["0"],
      ["false"],
      ["no"],
      ["off"],
      ["FALSE"],   // uppercase — lowercased by normalizeValue
      ["NO"],
      ["OFF"],
      [" false "], // leading/trailing whitespace — trimmed by normalizeValue
      [" 0 "],
    ])('returns false for "%s"', (value: string) => {
      vi.stubEnv("NEXT_PUBLIC_OBSERVABILITY_ENABLED", value);
      expect(isObservabilityEnabled()).toBe(false);
    });

    // Truthy signals — anything outside the opt-out list is treated as enabled
    it.each([
      ["true"],
      ["1"],
      ["yes"],
      ["on"],
      ["TRUE"],    // uppercase → lowercased to "true", not in opt-out list
      ["True"],
      ["YES"],
      ["ON"],
      ["true "],   // trailing space → trimmed to "true"
      [" true"],   // leading space
    ])('returns true for "%s"', (value: string) => {
      vi.stubEnv("NEXT_PUBLIC_OBSERVABILITY_ENABLED", value);
      expect(isObservabilityEnabled()).toBe(true);
    });

    // Ambiguous / unexpected strings — not in the opt-out list → enabled
    it('treats "disabled" as enabled (not in the opt-out list)', () => {
      vi.stubEnv("NEXT_PUBLIC_OBSERVABILITY_ENABLED", "disabled");
      // "disabled" is not one of {"0","false","no","off"} → returns true
      expect(isObservabilityEnabled()).toBe(true);
    });

    it('treats "enabled" as enabled', () => {
      vi.stubEnv("NEXT_PUBLIC_OBSERVABILITY_ENABLED", "enabled");
      expect(isObservabilityEnabled()).toBe(true);
    });

    it("returns true when env var is absent (default-on posture)", () => {
      // No stubEnv call → process.env value is undefined → normalizeValue → ""
      // → !raw branch fires → returns true
      expect(isObservabilityEnabled()).toBe(true);
    });

    it('returns true for empty string (default-on posture)', () => {
      vi.stubEnv("NEXT_PUBLIC_OBSERVABILITY_ENABLED", "");
      expect(isObservabilityEnabled()).toBe(true);
    });
  });

  // ── isObservabilityDebugEnabled ────────────────────────────────────────────

  describe("isObservabilityDebugEnabled", () => {
    // Enabled signals — the explicit opt-in list
    it.each([
      ["1"],
      ["true"],
      ["yes"],
      ["on"],
      ["TRUE"],    // uppercase → lowercased to "true"
      ["YES"],
      ["ON"],
      ["True"],
      ["true "],   // trailing space → trimmed to "true"
      [" 1"],      // leading space → trimmed to "1"
    ])('returns true for "%s"', (value: string) => {
      vi.stubEnv("NEXT_PUBLIC_OBSERVABILITY_DEBUG", value);
      expect(isObservabilityDebugEnabled()).toBe(true);
    });

    // Disabled signals — anything outside the opt-in list
    it.each([
      ["0"],
      ["false"],
      ["no"],
      ["off"],
      ["FALSE"],
      ["disabled"],
      ["enabled"],  // truthy-sounding word, but not in the opt-in list
      [""],
    ])('returns false for "%s"', (value: string) => {
      vi.stubEnv("NEXT_PUBLIC_OBSERVABILITY_DEBUG", value);
      expect(isObservabilityDebugEnabled()).toBe(false);
    });

    it("returns false when env var is absent", () => {
      // No stub → undefined → normalizeValue → "" → not in opt-in list
      expect(isObservabilityDebugEnabled()).toBe(false);
    });
  });

  // ── shouldLoadWebAnalyticsScripts ──────────────────────────────────────────

  describe("shouldLoadWebAnalyticsScripts — coercion interop with isObservabilityEnabled", () => {
    it('respects "YES" as a valid load-in-dev signal', () => {
      vi.stubEnv("NODE_ENV", "development");
      vi.stubEnv("NEXT_PUBLIC_OBSERVABILITY_LOAD_IN_DEV", "YES");
      expect(shouldLoadWebAnalyticsScripts()).toBe(true);
    });

    it('respects "ON" as a valid load-in-dev signal', () => {
      vi.stubEnv("NODE_ENV", "development");
      vi.stubEnv("NEXT_PUBLIC_OBSERVABILITY_LOAD_IN_DEV", "ON");
      expect(shouldLoadWebAnalyticsScripts()).toBe(true);
    });

    it('respects "true " (trailing space) as a valid load-in-dev signal', () => {
      vi.stubEnv("NODE_ENV", "development");
      vi.stubEnv("NEXT_PUBLIC_OBSERVABILITY_LOAD_IN_DEV", "true ");
      expect(shouldLoadWebAnalyticsScripts()).toBe(true);
    });

    it('returns false when observability is disabled via "0" even if load-in-dev is "1"', () => {
      vi.stubEnv("NODE_ENV", "development");
      vi.stubEnv("NEXT_PUBLIC_OBSERVABILITY_ENABLED", "0");
      vi.stubEnv("NEXT_PUBLIC_OBSERVABILITY_LOAD_IN_DEV", "1");
      // isObservabilityEnabled() returns false → short-circuits to false
      expect(shouldLoadWebAnalyticsScripts()).toBe(false);
    });

    it('returns false when observability is disabled via "FALSE" (uppercase)', () => {
      vi.stubEnv("NODE_ENV", "development");
      vi.stubEnv("NEXT_PUBLIC_OBSERVABILITY_ENABLED", "FALSE");
      vi.stubEnv("NEXT_PUBLIC_OBSERVABILITY_LOAD_IN_DEV", "true");
      expect(shouldLoadWebAnalyticsScripts()).toBe(false);
    });
  });
});
