import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  native: false,
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => mocks.native,
  },
}));

import {
  resolveAnalyticsMeasurementId,
  resolveGtmContainerId,
  shouldLoadWebAnalyticsScripts,
} from "@/lib/observability/env";
import {
  resetWebGtmHitBudgetForTests,
  refreshWebGtmPageContext,
  webGtmAdapter,
} from "@/lib/observability/adapters/web-gtm";
import { buildWebAnalyticsBootstrap, resolveAnalyticsPageContext } from "@/lib/observability/page-context";
import type { ObservabilityEventName } from "@/lib/observability/events";

declare global {
  interface Window {
    dataLayer?: Array<Record<string, unknown>>;
    gtag?: ReturnType<typeof vi.fn>;
  }
}

const UAT_MEASUREMENT_ID = "G-H1KGXGZTCF";
const DOCUMENT_REF = "11111111-2222-4333-8444-555555555555";

function installContextAwareGtag() {
  const globalContext: Record<string, unknown> = {};
  const streamContext: Record<string, unknown> = {};
  const hits: Array<Record<string, unknown>> = [];
  const automatic = (event = "user_engagement", payload = {}) => {
    hits.push({ event, page_location: window.location.href, page_referrer: document.referrer,
      ...globalContext, ...streamContext, ...payload });
  };
  window.gtag = vi.fn((command: string, value: unknown, params?: Record<string, unknown>) => {
    if (command === "set") Object.assign(globalContext, value);
    if (command === "config") Object.assign(streamContext, params);
    if (command === "event") automatic(String(value), params);
  });
  return { hits, automatic };
}

const api = (count: number): ObservabilityEventName[] =>
  Array.from({ length: count }, () => "api_request_completed");

/**
 * Event order recorded on uat.one.hushh.ai (252c9b1c5) for the release smoke's
 * reviewer journey, `/login?redirect=/kai` then `/one/kai?tab=portfolio`,
 * with gtag.js loading after all 46 events were queued. That run dropped
 * `portfolio_viewed` and `consent_pending_loaded`, as UAT deploys
 * 36456639658 and 36518015330 did.
 */
const RECORDED_DASHBOARD_LOAD: ObservabilityEventName[] = [
  "page_view",
  ...api(8),
  "growth_funnel_step_completed",
  "page_view",
  ...api(4),
  "warmup_completed",
  ...api(8),
  "warmup_completed",
  "portfolio_viewed",
  "api_request_completed",
  "growth_funnel_step_completed",
  "portfolio_viewed",
  ...api(3),
  "market_insights_loaded",
  ...api(8),
  "warmup_completed",
  "api_request_completed",
  "consent_pending_loaded",
  "api_request_completed",
  "startup_readiness_warmup_completed",
];

/**
 * gtag.js as served: calls queue in dataLayer until the script loads, then each
 * event passes its per-page limiter (the `grl` bucket: 20 tokens, +5/s, cap
 * 20) or is aborted without a request.
 */
function installRateLimitedGtag() {
  const queued: string[] = [];
  const delivered: string[] = [];
  let live = false;
  let tokens = 20;
  let lastAt = 0;
  const process = (eventName: string) => {
    const at = Date.now();
    tokens = Math.min(tokens + ((at - lastAt) / 1000) * 5, 20);
    lastAt = at;
    if (tokens < 1) return;
    tokens -= 1;
    delivered.push(eventName);
  };
  window.gtag = vi.fn((command: string, eventName: string) => {
    if (command !== "event") return;
    if (live) process(eventName);
    else queued.push(eventName);
  });
  return {
    delivered,
    load() {
      live = true;
      lastAt = Date.now();
      window.google_tag_manager = { [UAT_MEASUREMENT_ID]: {} };
      for (const eventName of queued.splice(0)) process(eventName);
    },
  };
}

async function trackThroughAdapter(eventName: ObservabilityEventName) {
  await webGtmAdapter.track(eventName, {
    env: "uat",
    platform: "web",
    app_version: "1.1.0",
  });
}

describe("web observability transport", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    mocks.native = false;
    delete window.__HUSHH_NATIVE_TEST__;
    window.dataLayer = [];
    window.gtag = vi.fn();
    delete window.google_tag_manager;
    resetWebGtmHitBudgetForTests();
    window.history.replaceState(null, "", "/");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("keeps product events deliverable when a dashboard burst meets gtag's event limit", async () => {
    vi.useFakeTimers();
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "uat");
    vi.stubEnv("NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID", UAT_MEASUREMENT_ID);
    const gtag = installRateLimitedGtag();

    for (const eventName of RECORDED_DASHBOARD_LOAD) {
      await trackThroughAdapter(eventName);
    }
    gtag.load();

    for (const eventName of [
      "page_view",
      "growth_funnel_step_completed",
      "portfolio_viewed",
      "market_insights_loaded",
      "consent_pending_loaded",
      "startup_readiness_warmup_completed",
    ]) {
      expect(gtag.delivered).toContain(eventName);
    }
    expect(gtag.delivered.filter((name) => name === "portfolio_viewed")).toHaveLength(2);
    // Every product event is still in dataLayer for GTM, whatever gtag does.
    expect(window.dataLayer).toHaveLength(RECORDED_DASHBOARD_LOAD.length);

    // The next event sees gtag.js live; from then the budget refills and API
    // health telemetry resumes rather than being starved for the page.
    await trackThroughAdapter("api_request_completed");
    expect(gtag.delivered.at(-1)).toBe("startup_readiness_warmup_completed");
    vi.advanceTimersByTime(3_000);
    await trackThroughAdapter("api_request_completed");
    expect(gtag.delivered.at(-1)).toBe("api_request_completed");
  });

  it("negative control: the same burst sent straight to gtag loses portfolio_viewed", () => {
    vi.useFakeTimers();
    const gtag = installRateLimitedGtag();

    for (const eventName of RECORDED_DASHBOARD_LOAD) {
      window.gtag?.("event", eventName, { send_to: UAT_MEASUREMENT_ID });
    }
    gtag.load();

    expect(gtag.delivered).toHaveLength(20);
    expect(gtag.delivered).not.toContain("portfolio_viewed");
    expect(gtag.delivered).not.toContain("consent_pending_loaded");
  });

  it("does not duplicate native events through the web transport", async () => {
    mocks.native = true;
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "uat");
    vi.stubEnv("NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID", "G-H1KGXGZTCF");

    expect(webGtmAdapter.isAvailable()).toBe(false);
    await webGtmAdapter.track("growth_funnel_step_completed", {
      env: "uat",
      platform: "ios",
      event_category: "funnel",
      journey: "investor",
      step: "entered",
      app_version: "2.1.0",
    });

    expect(window.dataLayer).toEqual([]);
    expect(window.gtag).not.toHaveBeenCalled();
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

  it("does not embed gtag or GTM scripts in Capacitor builds", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CAPACITOR_BUILD", "true");
    vi.stubEnv("NEXT_PUBLIC_OBSERVABILITY_ENABLED", "true");

    expect(shouldLoadWebAnalyticsScripts()).toBe(false);
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
        page_location: "http://localhost/",
        page_referrer: "",
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
        page_location: "http://localhost/",
        page_referrer: "",
      }
    );
  });

  it("does not send analytics from an explicit automated reviewer session", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "uat");
    vi.stubEnv("NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID", "G-H1KGXGZTCF");
    window.__HUSHH_NATIVE_TEST__ = {
      enabled: true,
      autoReviewerLogin: true,
    };

    await webGtmAdapter.track("page_view", {
      env: "uat",
      platform: "web",
      event_category: "system",
      route_id: "one_kyc",
    });

    expect(window.dataLayer).toEqual([]);
    expect(window.gtag).not.toHaveBeenCalled();
  });

  it("redacts protected locators from SDK defaults and explicit events", async () => {
    vi.stubEnv("NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID", UAT_MEASUREMENT_ID);
    window.history.replaceState(null, "", `/one/documents/open?ref=${DOCUMENT_REF}#private-fragment`);
    const sdk = installContextAwareGtag();
    new Function("window", "document", buildWebAnalyticsBootstrap(UAT_MEASUREMENT_ID))(window, document);
    sdk.automatic();
    await trackThroughAdapter("page_view");
    expect(sdk.hits).toHaveLength(2);
    expect(sdk.hits.every((hit) => hit.page_location === "http://localhost/one/documents/open")).toBe(true);
    expect(JSON.stringify(sdk.hits)).not.toContain(DOCUMENT_REF);
    expect(JSON.stringify(window.dataLayer)).not.toContain(DOCUMENT_REF);
  });

  it("overrides implicit SDK URL defaults even before bootstrap context exists", async () => {
    vi.stubEnv("NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID", UAT_MEASUREMENT_ID);
    window.history.replaceState(null, "", `/one/documents/open?ref=${DOCUMENT_REF}`);
    vi.spyOn(document, "referrer", "get").mockReturnValue(window.location.href);
    const sdk = installContextAwareGtag();
    await trackThroughAdapter("page_view");
    expect(sdk.hits).toHaveLength(1);
    expect(sdk.hits[0].page_location).toBe("http://localhost/one/documents/open");
    expect(sdk.hits[0].page_referrer).toBe("http://localhost/one/documents/open");
    expect(JSON.stringify(sdk.hits)).not.toContain(DOCUMENT_REF);
  });

  it("keeps ordinary campaign URL defaults out of custom metadata-only dataLayer events", async () => {
    vi.stubEnv("NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID", UAT_MEASUREMENT_ID);
    window.history.replaceState(null, "", "/one?utm_source=partner&email=synthetic%40example.invalid#private-id");
    const referrer = "https://external.invalid/?utm_campaign=launch";
    vi.spyOn(document, "referrer", "get").mockReturnValue(referrer);
    const sdk = installContextAwareGtag();
    await trackThroughAdapter("page_view");
    expect(window.dataLayer).toEqual([{
      event: "page_view", event_source: "observability_v2",
      env: "uat", platform: "web", app_version: "1.1.0",
    }]);
    expect(JSON.stringify(window.dataLayer)).not.toContain("synthetic");
    expect(window.dataLayer?.[0]).not.toHaveProperty("page_location");
    expect(window.dataLayer?.[0]).not.toHaveProperty("page_referrer");
    expect(sdk.hits[0].page_location).toBe(window.location.href);
    expect(sdk.hits[0].page_referrer).toBe(referrer);
  });

  it("refreshes SDK defaults on exit and strips a protected first-party referrer", async () => {
    vi.stubEnv("NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID", UAT_MEASUREMENT_ID);
    const protectedUrl = `http://localhost/one/documents/open?ref=${DOCUMENT_REF}#private-fragment`;
    vi.spyOn(document, "referrer", "get").mockReturnValue(protectedUrl);
    window.history.replaceState(null, "", `/one/documents/open?ref=${DOCUMENT_REF}`);
    const sdk = installContextAwareGtag();
    new Function("window", "document", buildWebAnalyticsBootstrap(UAT_MEASUREMENT_ID))(window, document);
    window.history.replaceState(null, "", "/one?utm_source=partner&utm_campaign=launch#top");
    refreshWebGtmPageContext();
    expect(sdk.hits).toEqual([]);
    sdk.automatic();
    await trackThroughAdapter("page_view");
    expect(sdk.hits.every((hit) => hit.page_location === window.location.href)).toBe(true);
    expect(sdk.hits.every((hit) => hit.page_referrer === "http://localhost/one/documents/open")).toBe(true);
    expect(JSON.stringify(sdk.hits)).not.toContain(DOCUMENT_REF);
  });

  it("keeps ordinary campaigns and external referrers while removing a protected login resume", () => {
    const ordinary = "https://one.hussh.si/one?utm_source=Partner%20A&utm_campaign=launch#top";
    const external = "https://external.invalid/one/documents/open?ref=external-campaign#section";
    expect(resolveAnalyticsPageContext(ordinary, external)).toEqual({ page_location: ordinary, page_referrer: external });
    const nested = `https://one.hussh.si/login?redirect=${encodeURIComponent(`/one/documents/open?ref=${DOCUMENT_REF}`)}&utm_source=partner#top`;
    expect(resolveAnalyticsPageContext(nested, nested)).toEqual({
      page_location: "https://one.hussh.si/login?utm_source=partner#top",
      page_referrer: "https://one.hussh.si/login?utm_source=partner#top",
    });
    const neighbor = "https://one.hussh.si/one/documents/open-other?utm_source=partner#top";
    expect(resolveAnalyticsPageContext(neighbor, ordinary)).toEqual({ page_location: neighbor, page_referrer: ordinary });
  });

  it("negative control: send_page_view false alone leaves automatic SDK URL defaults readable", () => {
    window.history.replaceState(null, "", `/one/documents/open?ref=${DOCUMENT_REF}`);
    const sdk = installContextAwareGtag();
    new Function("window", "window.gtag('config','G-H1KGXGZTCF',{send_page_view:false});")(window);
    sdk.automatic();
    expect(JSON.stringify(sdk.hits)).toContain(DOCUMENT_REF);
  });
});
