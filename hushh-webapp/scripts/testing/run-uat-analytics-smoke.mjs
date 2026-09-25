#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";
import { classifyCollectSettlement } from "./analytics-collect-delivery.mjs";
import {
  defaultReviewerIdentityEnvFiles,
  resolveReviewerTestIdentity,
  sanitizeConfiguredValue,
} from "./reviewer-test-identity.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const webDir = path.resolve(__dirname, "..", "..");
const repoRoot = path.resolve(webDir, "..");

const appOrigin = (
  sanitizeConfiguredValue(process.env.UAT_ANALYTICS_SMOKE_ORIGIN) ||
  sanitizeConfiguredValue(process.env.HUSHH_UAT_APP_ORIGIN) ||
  "https://uat.one.hushh.ai"
).replace(/\/$/, "");
const expectedMeasurementId =
  sanitizeConfiguredValue(
    process.env.UAT_ANALYTICS_SMOKE_EXPECTED_MEASUREMENT_ID,
  ) || "G-H1KGXGZTCF";
const forbiddenMeasurementIds = new Set(
  String(
    process.env.UAT_ANALYTICS_SMOKE_FORBIDDEN_MEASUREMENT_IDS || "G-2PCECPSKCR",
  )
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);
const fixturePolicy =
  "reuse the existing reviewer test fixture instead of creating another user or environment";
let reviewerIdentity;
try {
  reviewerIdentity = resolveReviewerTestIdentity({
    envFiles: defaultReviewerIdentityEnvFiles({ repoRoot, webDir }),
  });
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
const reviewerPassphrase = reviewerIdentity.reviewerVaultPassphrase;
const smokeUserId = reviewerIdentity.reviewerUid;
const fullJourney = process.argv.includes("--full");
const smokeTicker =
  sanitizeConfiguredValue(process.env.UAT_ANALYTICS_SMOKE_TICKER) || "AAPL";
const defaultTimeoutMs = Number(
  process.env.UAT_ANALYTICS_SMOKE_TIMEOUT_MS || 120_000,
);
const analysisTimeoutMs = Number(
  process.env.UAT_ANALYTICS_SMOKE_ANALYSIS_TIMEOUT_MS || 420_000,
);

function fail(message) {
  console.error(`[uat analytics smoke] ${message}`);
  console.error(
    JSON.stringify(
      {
        status: "fail",
        origin: appOrigin,
        expectedMeasurementId,
        reason: message,
        classification: classifySmokeFailure(message),
        fixturePolicy,
      },
      null,
      2,
    ),
  );
  process.exit(1);
}

function classifySmokeFailure(message) {
  if (/missing canonical reviewer test identity/i.test(message)) {
    return "missing_fixture_credentials";
  }
  if (
    /portfolio_viewed|recommendation_viewed|investor_activation_completed/i.test(
      message,
    )
  ) {
    return "portfolio_analysis_or_activation_instrumentation";
  }
  if (/measurement ID|forbidden production measurement/i.test(message)) {
    return "measurement_id_or_sink_mismatch";
  }
  return "runtime_or_instrumentation_failure";
}

function validateRequiredParams(eventName, payload) {
  const required = ["platform", "event_category", "app_version"];
  if (
    eventName === "growth_funnel_step_completed" ||
    eventName === "investor_activation_completed"
  ) {
    required.push("journey", "entry_surface");
  }
  if (eventName === "growth_funnel_step_completed") {
    required.push("step");
  }
  if (eventName === "portfolio_viewed") {
    required.push("result", "portfolio_source");
  }
  const missing = required.filter(
    (key) => payload[key] === undefined || payload[key] === "",
  );
  if (missing.length > 0) {
    throw new Error(
      `${eventName} missing required param(s): ${missing.join(", ")}`,
    );
  }
  if (payload.platform !== "web") {
    throw new Error(
      `${eventName} platform is ${payload.platform}, expected web`,
    );
  }
  if (payload.env !== "uat") {
    throw new Error(`${eventName} env is ${payload.env}, expected uat`);
  }
}

async function installAnalyticsCapture(page) {
  await page.addInitScript(
    ({ expectedUserId, vaultPassphrase }) => {
      window.__HUSHH_NATIVE_TEST__ = {
        ...(window.__HUSHH_NATIVE_TEST__ || {}),
        enabled: true,
        autoReviewerLogin: true,
        allowUatAnalyticsSmokeTelemetry: true,
        expectedUserId,
        vaultPassphrase,
      };
    },
    {
      expectedUserId: smokeUserId,
      vaultPassphrase: reviewerPassphrase,
    },
  );
}

async function getSmokeState(page) {
  return page.evaluate(() => {
    const events = [];
    const measurementIds = [];
    const dataLayer = Array.isArray(window.dataLayer) ? window.dataLayer : [];
    for (const item of dataLayer) {
      if (item && typeof item === "object" && typeof item.event === "string") {
        events.push({
          event: item.event,
          source: "dataLayer",
          payload: { ...item },
          at: 0,
        });
        continue;
      }
      const args = Array.from(item || []);
      if (args[0] === "config" && typeof args[1] === "string") {
        measurementIds.push(args[1]);
        continue;
      }
      if (args[0] === "event" && typeof args[1] === "string") {
        const payload =
          args[2] && typeof args[2] === "object" ? { ...args[2] } : {};
        events.push({
          event: args[1],
          source: "dataLayer_gtag_args",
          payload,
          at: 0,
        });
      }
    }
    return {
      events,
      measurementIds,
      scriptMeasurementIds: Array.from(document.scripts)
        .map((script) => script.src || "")
        .filter((src) => src.includes("googletagmanager.com/gtag/js?id="))
        .map((src) => new URL(src).searchParams.get("id"))
        .filter(Boolean),
    };
  });
}

async function waitForMeasurementId(page) {
  await page.waitForFunction(
    (expected) => {
      const captured = new Set();
      const dataLayer = Array.isArray(window.dataLayer) ? window.dataLayer : [];
      for (const item of dataLayer) {
        const args = Array.from(item || []);
        if (args[0] === "config" && typeof args[1] === "string") {
          captured.add(args[1]);
        }
      }
      for (const script of Array.from(document.scripts)) {
        const src = script.src || "";
        if (!src.includes("googletagmanager.com/gtag/js?id=")) continue;
        captured.add(new URL(src).searchParams.get("id"));
      }
      return captured.has(expected);
    },
    expectedMeasurementId,
    { timeout: defaultTimeoutMs },
  );
}

async function waitForAnalyticsEvent(
  page,
  eventName,
  predicate = () => true,
  timeout = defaultTimeoutMs,
) {
  const deadline = Date.now() + timeout;
  let lastSeenCount = 0;
  while (Date.now() < deadline) {
    const state = await getSmokeState(page);
    const candidates = state.events.filter(
      (entry) => entry.event === eventName,
    );
    lastSeenCount = candidates.length;
    const match = candidates.find((entry) => predicate(entry.payload));
    if (match) {
      validateRequiredParams(eventName, match.payload);
      return match;
    }
    await page.waitForTimeout(500);
  }
  throw new Error(
    lastSeenCount > 0
      ? `${eventName} appeared, but not with the expected payload`
      : `${eventName} did not appear within ${timeout} ms`,
  );
}

async function clickIfVisible(locator) {
  if (await locator.isVisible().catch(() => false)) {
    await locator.click();
    return true;
  }
  return false;
}

async function clickRequired(locator, label) {
  try {
    await locator.waitFor({ state: "visible", timeout: defaultTimeoutMs });
  } catch {
    throw new Error(
      `${label} did not become visible within ${defaultTimeoutMs} ms`,
    );
  }
  await locator.click();
}

async function waitForReviewerVaultBootstrap(page) {
  await page.waitForFunction(
    (expectedUserId) => {
      const bridge = window.__HUSHH_NATIVE_TEST__;
      return (
        bridge?.bootstrapState === "vault_unlocked" &&
        bridge?.bootstrapUserId === expectedUserId
      );
    },
    smokeUserId,
    { timeout: defaultTimeoutMs },
  );
}

async function assertVaultStillUnlocked(page, routeLabel) {
  const unlockVisible = await page
    .locator("#unlock-passphrase")
    .isVisible()
    .catch(() => false);
  if (unlockVisible) {
    throw new Error(
      `${routeLabel} relocked the vault after same-session navigation`,
    );
  }
  const bootstrapState = await page.evaluate(
    () => window.__HUSHH_NATIVE_TEST__?.bootstrapState || "",
  );
  if (bootstrapState && bootstrapState !== "vault_unlocked") {
    throw new Error(
      `${routeLabel} reviewer vault bootstrap state is ${bootstrapState}`,
    );
  }
}

// `/login?redirect=/kai` resolves to the Finance dashboard via `/kai`. The
// reviewer unlock can finish before that redirect lands; navigating first lets
// the late redirect overwrite the URL, so wait for it to settle.
const loginRedirectLandingPath = "/one/kai";

async function waitForLoginRedirectToSettle(page) {
  await page.waitForFunction(
    (landingPath) => window.location.pathname === landingPath,
    loginRedirectLandingPath,
    { timeout: defaultTimeoutMs },
  );
}

async function navigateInApp(page, href) {
  const dispatched = await page.evaluate((targetHref) => {
    window.dispatchEvent(
      new CustomEvent("app-internal-navigation-requested", {
        detail: { href: targetHref, scroll: false },
      }),
    );
    return true;
  }, href);
  if (!dispatched) {
    throw new Error(`failed to dispatch Next client navigation for ${href}`);
  }
  await page.waitForFunction(
    (targetHref) =>
      `${window.location.pathname}${window.location.search}` === targetHref,
    href,
    { timeout: defaultTimeoutMs },
  );
  await assertVaultStillUnlocked(page, href);
}

const analyticsRequestMeasurementIds = [];
const analyticsCollectEvents = [];
const analyticsRequestIds = new WeakMap();
let nextAnalyticsRequestId = 1;

function getAnalyticsRequestId(request) {
  let requestId = analyticsRequestIds.get(request);
  if (!requestId) {
    requestId = `ga-${nextAnalyticsRequestId}`;
    nextAnalyticsRequestId += 1;
    analyticsRequestIds.set(request, requestId);
  }
  return requestId;
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
});
const page = await context.newPage();
page.setDefaultNavigationTimeout(defaultTimeoutMs);
page.setDefaultTimeout(defaultTimeoutMs);
await installAnalyticsCapture(page);

page.on("request", (request) => {
  const url = request.url();
  if (!isAnalyticsCollectUrl(url)) return;
  const collectEvents = parseAnalyticsCollectRequests(request);
  for (const collect of collectEvents) {
    analyticsRequestMeasurementIds.push(collect.measurementId);
    if (!collect.eventName) continue;
    analyticsCollectEvents.push({
      ...collect,
      requestId: getAnalyticsRequestId(request),
      status: "requested",
    });
  }
});

page.on("requestfinished", async (request) => {
  const response = await request.response().catch(() => null);
  for (const collect of parseAnalyticsCollectRequests(request)) {
    if (!collect.eventName) continue;
    analyticsCollectEvents.push({
      ...collect,
      requestId: getAnalyticsRequestId(request),
      status: response?.ok() ? "finished" : "failed",
      httpStatus: response?.status() ?? 0,
    });
  }
});

// GA4 beacons never emit requestfinished: they end here with ERR_ABORTED
// after GA4's 204. The response, not the event name, decides delivery.
async function recordCollectRequestFailure(request) {
  const collectEvents = parseAnalyticsCollectRequests(request).filter(
    (collect) => collect.eventName,
  );
  if (collectEvents.length === 0) return;
  const response = await request.response().catch(() => null);
  const httpStatus = response?.status() ?? 0;
  const failureText = request.failure()?.errorText || "unknown";
  const status = classifyCollectSettlement({
    settledBy: "requestfailed",
    responseStatus: httpStatus,
    failureText,
  });
  for (const collect of collectEvents) {
    analyticsCollectEvents.push({
      ...collect,
      requestId: getAnalyticsRequestId(request),
      status,
      httpStatus,
      failureText,
    });
  }
}

page.on("requestfailed", (request) => {
  void recordCollectRequestFailure(request);
});

function parseAnalyticsCollectRequests(request) {
  const url = request.url();
  if (!isAnalyticsCollectUrl(url)) return [];
  try {
    const parsed = new URL(url);
    const measurementId = parsed.searchParams.get("tid");
    const collectFrom = (params) => ({
      measurementId,
      eventName: params.get("en") || "",
      route_id: params.get("ep.route_id") || "",
      journey: params.get("ep.journey") || "",
      step: params.get("ep.step") || "",
      result: params.get("ep.result") || "",
      entry_surface: params.get("ep.entry_surface") || "",
      portfolio_source: params.get("ep.portfolio_source") || "",
    });
    const queryEventName = parsed.searchParams.get("en");
    if (!measurementId) return [];
    if (queryEventName) {
      return [collectFrom(parsed.searchParams)];
    }
    const postData =
      request.postData() ||
      (typeof request.postDataBuffer === "function"
        ? request.postDataBuffer()?.toString("utf8")
        : "") ||
      "";
    const bodyEvents = [];
    for (const line of postData.split(/\r?\n/)) {
      const bodyParams = new URLSearchParams(line);
      const bodyEventName = bodyParams.get("en");
      if (bodyEventName) {
        for (const [key, value] of parsed.searchParams.entries()) {
          if (!bodyParams.has(key)) bodyParams.set(key, value);
        }
        bodyEvents.push(collectFrom(bodyParams));
      }
    }
    return bodyEvents.length > 0
      ? bodyEvents
      : [{ measurementId, eventName: "" }];
  } catch {
    return [];
  }
}

function isAnalyticsCollectUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.toLowerCase();
    return (
      (host.endsWith("google-analytics.com") ||
        host.endsWith("analytics.google.com")) &&
      parsed.pathname.includes("collect")
    );
  } catch {
    return false;
  }
}

function isCollectEventDelivered(observed, { eventName, params }) {
  return observed.some(
    (entry) =>
      entry.measurementId === expectedMeasurementId &&
      entry.eventName === eventName &&
      Object.entries(params).every(([key, value]) => entry[key] === value) &&
      entry.status === "finished" &&
      !observed.some(
        (candidate) =>
          candidate.requestId === entry.requestId &&
          candidate.status === "failed",
      ),
  );
}

async function waitForAnalyticsCollectEvents(requiredEvents) {
  const deadline = Date.now() + defaultTimeoutMs;
  let missing = requiredEvents;
  while (Date.now() < deadline) {
    missing = requiredEvents.filter(
      (requiredEvent) =>
        !isCollectEventDelivered(analyticsCollectEvents, requiredEvent),
    );
    if (missing.length === 0) return;
    await page.waitForTimeout(500);
  }
  throw new Error(
    `GA collect delivery (2xx) not proven for: ${missing
      .map(({ eventName }) => eventName)
      .join(", ")}`,
  );
}

try {
  await page.goto(`${appOrigin}/login?redirect=${encodeURIComponent("/kai")}`, {
    waitUntil: "domcontentloaded",
  });
  await waitForMeasurementId(page);

  const reviewerButton = page.getByRole("button", {
    name: /continue as reviewer/i,
  });
  await clickIfVisible(reviewerButton);
  await waitForReviewerVaultBootstrap(page);
  await waitForLoginRedirectToSettle(page);

  await navigateInApp(page, "/one/kai?tab=portfolio");
  const routeViewEvent = await waitForAnalyticsEvent(
    page,
    "page_view",
    (payload) => payload.route_id === "kai_home",
  );
  const portfolioEvent = await waitForAnalyticsEvent(
    page,
    "portfolio_viewed",
    (payload) =>
      payload.result === "success" && Boolean(payload.portfolio_source),
    analysisTimeoutMs,
  );

  const requiredCollectEvents = [
    { eventName: "page_view", params: { route_id: "kai_home" } },
    {
      eventName: "portfolio_viewed",
      params: {
        result: "success",
        portfolio_source: portfolioEvent.payload.portfolio_source,
      },
    },
  ];
  const outputEvents = {
    page_view: routeViewEvent.payload,
    portfolio_viewed: portfolioEvent.payload,
  };

  if (fullJourney) {
    await navigateInApp(
      page,
      `/one/kai?tab=analysis&ticker=${encodeURIComponent(smokeTicker)}&pickSource=default`,
    );
    const startButton = page
      .getByRole("button", {
        name: /start debate|start analysis|run debate|run analysis|begin debate|begin analysis/i,
      })
      .first();
    await clickRequired(startButton, "analysis start command");
    const recommendationEvent = await waitForAnalyticsEvent(
      page,
      "recommendation_viewed",
      (payload) => payload.result === "success",
      analysisTimeoutMs,
    );
    const activationEvent = await waitForAnalyticsEvent(
      page,
      "investor_activation_completed",
      (payload) =>
        payload.journey === "investor" && Boolean(payload.entry_surface),
      defaultTimeoutMs,
    );
    requiredCollectEvents.push(
      { eventName: "recommendation_viewed", params: { result: "success" } },
      {
        eventName: "investor_activation_completed",
        params: {
          journey: "investor",
          entry_surface: activationEvent.payload.entry_surface,
        },
      },
    );
    outputEvents.recommendation_viewed = recommendationEvent.payload;
    outputEvents.investor_activation_completed = activationEvent.payload;
  }

  await waitForAnalyticsCollectEvents(requiredCollectEvents);

  const state = await getSmokeState(page);
  const measurementIds = new Set([
    ...state.measurementIds,
    ...state.scriptMeasurementIds,
    ...analyticsRequestMeasurementIds,
  ]);
  if (!measurementIds.has(expectedMeasurementId)) {
    throw new Error(`measurement ID ${expectedMeasurementId} was not observed`);
  }
  const leaked = [...measurementIds].filter((id) =>
    forbiddenMeasurementIds.has(id),
  );
  if (leaked.length > 0) {
    throw new Error(
      `forbidden production measurement ID(s) observed: ${leaked.join(", ")}`,
    );
  }

  console.log(
    JSON.stringify(
      {
        status: "pass",
        origin: appOrigin,
        expectedMeasurementId,
        observedMeasurementIds: [...measurementIds].sort(),
        observedGaCollectEvents: [
          ...new Set(
            analyticsCollectEvents
              .filter(
                (entry) =>
                  entry.measurementId === expectedMeasurementId &&
                  entry.eventName &&
                  entry.status !== "failed",
              )
              .map((entry) => entry.eventName),
          ),
        ].sort(),
        observedGaCollectStatuses: analyticsCollectEvents
          .filter(
            (entry) =>
              entry.measurementId === expectedMeasurementId && entry.eventName,
          )
          .map((entry) => ({
            eventName: entry.eventName,
            status: entry.status,
            failureText: entry.failureText,
          })),
        mode: fullJourney ? "full" : "promotion",
        events: outputEvents,
      },
      null,
      2,
    ),
  );
} catch (error) {
  const state = await getSmokeState(page).catch(() => ({
    events: [],
    measurementIds: [],
  }));
  const reason = error instanceof Error ? error.message : String(error);
  console.error(
    JSON.stringify(
      {
        status: "fail",
        origin: appOrigin,
        expectedMeasurementId,
        reason,
        classification: classifySmokeFailure(reason),
        fixturePolicy,
        observedEventNames: [
          ...new Set((state.events || []).map((entry) => entry.event)),
        ],
        observedMeasurementIds: [
          ...new Set([
            ...(state.measurementIds || []),
            ...(state.scriptMeasurementIds || []),
            ...analyticsRequestMeasurementIds,
          ]),
        ],
        observedGaCollectEvents: [
          ...new Set(
            analyticsCollectEvents
              .filter((entry) => entry.measurementId === expectedMeasurementId)
              .map((entry) => `${entry.eventName}:${entry.status}`),
          ),
        ].sort(),
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
} finally {
  await context.close().catch(() => {});
  await browser.close().catch(() => {});
}
