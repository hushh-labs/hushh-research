import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => false,
    getPlatform: () => "web",
  },
}));

import {
  captureGrowthAttribution,
  rememberLocationInviteSource,
  resolveGrowthJourneyForPath,
  trackGrowthFunnelStepCompleted,
  trackInvestorActivationCompleted,
  trackLocationActivationCompleted,
  trackLocationFunnelStepCompleted,
} from "@/lib/observability/growth";

declare global {
  interface Window {
    dataLayer?: Array<Record<string, unknown>>;
  }
}

describe("growth observability contract", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv("NEXT_PUBLIC_OBSERVABILITY_ENABLED", "true");
    vi.stubEnv("NEXT_PUBLIC_OBSERVABILITY_SAMPLE_RATE", "1");
    vi.stubEnv("NEXT_PUBLIC_CLIENT_VERSION", "2.1.0");
    window.dataLayer = [];
    window.localStorage.clear();
    window.sessionStorage.clear();
    window.history.replaceState({}, "", "/login?redirect=%2Fkai&utm_source=growth");
  });

  it("preserves entry context and emits growth events in order through dataLayer", () => {
    captureGrowthAttribution("/login");

    trackGrowthFunnelStepCompleted({
      journey: "investor",
      step: "entered",
      entrySurface: "login",
      dedupeKey: "growth:investor:entered:test",
      dedupeWindowMs: 5_000,
    });

    trackGrowthFunnelStepCompleted({
      journey: "investor",
      step: "auth_completed",
      authMethod: "google",
      dedupeKey: "growth:investor:auth:test",
      dedupeWindowMs: 5_000,
    });

    trackInvestorActivationCompleted({
      portfolioSource: "statement",
      dedupeKey: "growth:investor:activation:test",
      dedupeWindowMs: 10_000,
    });

    expect(window.dataLayer).toHaveLength(3);
    expect(window.dataLayer?.map((entry) => entry.event)).toEqual([
      "growth_funnel_step_completed",
      "growth_funnel_step_completed",
      "investor_activation_completed",
    ]);

    const [entered, authed, activated] = window.dataLayer as Array<
      Record<string, unknown>
    >;

    expect(entered.event_source).toBe("observability_v2");
    expect(entered.event_category).toBe("funnel");
    expect(entered.entry_surface).toBe("login");
    expect(authed.event_category).toBe("funnel");
    expect(authed.auth_method).toBe("google");
    expect(authed.entry_surface).toBe("login");
    expect(activated.event_category).toBe("funnel");
    expect(activated.journey).toBe("investor");
    expect(activated.portfolio_source).toBe("statement");
    expect(activated.app_version).toBe("2.1.0");
  });
});

describe("one location growth funnel", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv("NEXT_PUBLIC_OBSERVABILITY_ENABLED", "true");
    vi.stubEnv("NEXT_PUBLIC_OBSERVABILITY_SAMPLE_RATE", "1");
    vi.stubEnv("NEXT_PUBLIC_CLIENT_VERSION", "2.1.0");
    window.dataLayer = [];
    window.localStorage.clear();
    window.sessionStorage.clear();
    window.history.replaceState({}, "", "/one/location");
  });

  it("routes location surfaces to the location journey", () => {
    expect(resolveGrowthJourneyForPath("/one/location")).toBe("location");
    expect(resolveGrowthJourneyForPath("/one/location/check-in")).toBe(
      "location",
    );
    expect(resolveGrowthJourneyForPath("/circle/join")).toBe("location");
    expect(resolveGrowthJourneyForPath("/one/setup/location")).toBe("location");
    expect(resolveGrowthJourneyForPath("/marketplace")).toBeNull();
  });

  it("emits each funnel step at most once per user, across reloads", () => {
    trackLocationFunnelStepCompleted("phone_verified");
    trackLocationFunnelStepCompleted("phone_verified");
    trackLocationFunnelStepCompleted("vault_unlocked");

    expect(window.dataLayer).toHaveLength(2);
    expect(
      window.dataLayer?.map((entry) => entry.step),
    ).toEqual(["phone_verified", "vault_unlocked"]);

    // A reload clears the in-memory dedupe in client.ts but must not let a
    // completed step re-enter the funnel and inflate its denominator.
    window.dataLayer = [];
    trackLocationFunnelStepCompleted("phone_verified");
    expect(window.dataLayer).toHaveLength(0);
  });

  it("activates once, carrying the first-touch invite source", () => {
    rememberLocationInviteSource("circle_code");
    // A later arrival must not relabel the acquisition.
    rememberLocationInviteSource("public_link");

    trackLocationActivationCompleted({
      activationPath: "share_sent",
      recipientCountBucket: "2_3",
      shareDurationBucket: "1h",
    });
    trackLocationActivationCompleted({ activationPath: "share_received" });

    expect(window.dataLayer).toHaveLength(1);
    const [activated] = window.dataLayer as Array<Record<string, unknown>>;
    expect(activated.event).toBe("one_location_activation_completed");
    expect(activated.event_category).toBe("funnel");
    expect(activated.journey).toBe("location");
    expect(activated.activation_path).toBe("share_sent");
    expect(activated.invite_source).toBe("circle_code");
    expect(activated.recipient_count_bucket).toBe("2_3");
    expect(activated.app_version).toBe("2.1.0");
  });

  it("does not burn a funnel step when the event is dropped by sampling", () => {
    // The claim used to be written before `trackEvent` ran. With sampling below
    // 1, a single failed roll permanently consumed that user's step, so the
    // funnel lost individual steps per-device instead of degrading to a clean
    // sample.
    vi.stubEnv("NEXT_PUBLIC_OBSERVABILITY_SAMPLE_RATE", "0");
    trackLocationFunnelStepCompleted("phone_verified");
    expect(window.dataLayer).toHaveLength(0);

    vi.stubEnv("NEXT_PUBLIC_OBSERVABILITY_SAMPLE_RATE", "1");
    trackLocationFunnelStepCompleted("phone_verified");
    expect(window.dataLayer).toHaveLength(1);
    expect(window.dataLayer?.[0]?.step).toBe("phone_verified");
  });

  it("keeps a campaign tagged without utm_source", () => {
    // The first-touch guard keyed on utm_source alone, so a link carrying only
    // medium and campaign was wiped by the next navigation.
    window.history.replaceState(
      {},
      "",
      "/one/location?utm_medium=social&utm_campaign=privacy_launch",
    );
    captureGrowthAttribution("/one/location");
    window.history.replaceState({}, "", "/login");
    captureGrowthAttribution("/login");

    const stored = JSON.parse(
      window.localStorage.getItem("hushh_growth_context_v1") || "{}",
    );
    expect(stored.attribution.utmMedium).toBe("social");
    expect(stored.attribution.utmCampaign).toBe("privacy_launch");
  });

  it("persists first-touch campaign values across the auth boundary", () => {
    window.history.replaceState(
      {},
      "",
      "/one/location?utm_source=reddit&utm_medium=social&utm_campaign=privacy_launch",
    );
    captureGrowthAttribution("/one/location");

    // The One auth gate navigates away from the tagged URL before activation.
    window.history.replaceState({}, "", "/login");
    captureGrowthAttribution("/login");

    const stored = JSON.parse(
      window.localStorage.getItem("hushh_growth_context_v1") || "{}",
    );
    expect(stored.attribution.utmSource).toBe("reddit");
    expect(stored.attribution.utmMedium).toBe("social");
    expect(stored.attribution.utmCampaign).toBe("privacy_launch");
  });
});
