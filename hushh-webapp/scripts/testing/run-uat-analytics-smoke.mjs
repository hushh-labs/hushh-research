#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";
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
  "https://uat.kai.hushh.ai"
).replace(/\/$/, "");
const expectedMeasurementId =
  sanitizeConfiguredValue(process.env.UAT_ANALYTICS_SMOKE_EXPECTED_MEASUREMENT_ID) ||
  "G-H1KGXGZTCF";
const forbiddenMeasurementIds = new Set(
  String(process.env.UAT_ANALYTICS_SMOKE_FORBIDDEN_MEASUREMENT_IDS || "G-2PCECPSKCR")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
);
const fixturePolicy =
  "reuse the existing reviewer test fixture; if seeded portfolio or recommendation state is stale, repair that fixture instead of creating another user or environment";
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
const smokeTicker = sanitizeConfiguredValue(process.env.UAT_ANALYTICS_SMOKE_TICKER) || "AAPL";
const defaultTimeoutMs = Number(process.env.UAT_ANALYTICS_SMOKE_TIMEOUT_MS || 120_000);
const analysisTimeoutMs = Number(
  process.env.UAT_ANALYTICS_SMOKE_ANALYSIS_TIMEOUT_MS || 420_000
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
      2
    )
  );
  process.exit(1);
}

function classifySmokeFailure(message) {
  if (/missing canonical reviewer test identity/i.test(message)) {
    return "missing_fixture_credentials";
  }
  if (/portfolio_viewed/i.test(message)) {
    return "missing_or_unusable_seeded_portfolio_state";
  }
  if (/recommendation_viewed|investor_activation_completed/i.test(message)) {
    return "analysis_recommendation_or_activation_instrumentation";
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
  const missing = required.filter((key) => payload[key] === undefined || payload[key] === "");
  if (missing.length > 0) {
    throw new Error(`${eventName} missing required param(s): ${missing.join(", ")}`);
  }
  if (payload.platform !== "web") {
    throw new Error(`${eventName} platform is ${payload.platform}, expected web`);
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
        expectedUserId,
        vaultPassphrase,
      };
    },
    {
      expectedUserId: smokeUserId,
      vaultPassphrase: reviewerPassphrase,
    }
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
        const payload = args[2] && typeof args[2] === "object" ? { ...args[2] } : {};
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
    { timeout: defaultTimeoutMs }
  );
}

async function waitForAnalyticsEvent(page, eventName, predicate = () => true, timeout = defaultTimeoutMs) {
  const deadline = Date.now() + timeout;
  let lastSeenCount = 0;
  while (Date.now() < deadline) {
    const state = await getSmokeState(page);
    const candidates = state.events.filter((entry) => entry.event === eventName);
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
      : `${eventName} did not appear within ${timeout} ms`
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
  } catch (error) {
    throw new Error(`${label} did not become visible within ${defaultTimeoutMs} ms`);
  }
  await locator.click();
  return true;
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
    { timeout: defaultTimeoutMs }
  );
}

async function assertVaultStillUnlocked(page, routeLabel) {
  const unlockVisible = await page.locator("#unlock-passphrase").isVisible().catch(() => false);
  if (unlockVisible) {
    throw new Error(`${routeLabel} relocked the vault after same-session navigation`);
  }
  const bootstrapState = await page.evaluate(() => window.__HUSHH_NATIVE_TEST__?.bootstrapState || "");
  if (bootstrapState && bootstrapState !== "vault_unlocked") {
    throw new Error(`${routeLabel} reviewer vault bootstrap state is ${bootstrapState}`);
  }
}

async function navigateInApp(page, href) {
  const dispatched = await page.evaluate((targetHref) => {
    window.dispatchEvent(
      new CustomEvent("app-internal-navigation-requested", {
        detail: { href: targetHref, scroll: false },
      })
    );
    return true;
  }, href);
  if (!dispatched) {
    throw new Error(`failed to dispatch Next client navigation for ${href}`);
  }
  await page.waitForFunction(
    (targetHref) => `${window.location.pathname}${window.location.search}` === targetHref,
    href,
    { timeout: defaultTimeoutMs }
  );
  await assertVaultStillUnlocked(page, href);
}

const analyticsRequestMeasurementIds = [];
const analyticsCollectEvents = [];
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
    analyticsCollectEvents.push({ ...collect, status: "requested" });
  }
});

page.on("requestfinished", (request) => {
  for (const collect of parseAnalyticsCollectRequests(request)) {
    if (!collect.eventName) continue;
    analyticsCollectEvents.push({ ...collect, status: "finished" });
  }
});

page.on("requestfailed", (request) => {
  for (const collect of parseAnalyticsCollectRequests(request)) {
    if (!collect.eventName) continue;
    analyticsCollectEvents.push({
      ...collect,
      status: "failed",
      failureText: request.failure()?.errorText || "unknown",
    });
  }
});

function parseAnalyticsCollectRequests(request) {
  const url = request.url();
  if (!isAnalyticsCollectUrl(url)) return [];
  try {
    const parsed = new URL(url);
    const measurementId = parsed.searchParams.get("tid");
    const queryEventName = parsed.searchParams.get("en");
    if (!measurementId) return [];
    if (queryEventName) {
      return [{ measurementId, eventName: queryEventName }];
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
        bodyEvents.push({ measurementId, eventName: bodyEventName });
      }
    }
    return bodyEvents.length > 0 ? bodyEvents : [{ measurementId, eventName: "" }];
  } catch {
    return [];
  }
}

function isAnalyticsCollectUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.toLowerCase();
    return (
      (host.endsWith("google-analytics.com") || host.endsWith("analytics.google.com")) &&
      parsed.pathname.includes("collect")
    );
  } catch {
    return false;
  }
}

async function waitForAnalyticsCollectEvents(eventNames) {
  const required = new Set(eventNames);
  await page.waitForFunction(
    ({ expectedMeasurementId: measurementId, requiredEvents }) => {
      const observed = window.__HUSHH_ANALYTICS_COLLECT_EVENTS__ || [];
      return requiredEvents.every((eventName) =>
        observed.some(
          (entry) =>
            entry.measurementId === measurementId &&
            entry.eventName === eventName &&
            (entry.status === "requested" || entry.status === "finished")
        )
      );
    },
    {
      expectedMeasurementId,
      requiredEvents: [...required],
    },
    { timeout: defaultTimeoutMs }
  );
}

try {
  await page.addInitScript(() => {
    window.__HUSHH_ANALYTICS_COLLECT_EVENTS__ = [];
  });
  const mirrorCollectEvent = async (entry) => {
    await page.evaluate((value) => {
      window.__HUSHH_ANALYTICS_COLLECT_EVENTS__ =
        window.__HUSHH_ANALYTICS_COLLECT_EVENTS__ || [];
      window.__HUSHH_ANALYTICS_COLLECT_EVENTS__.push(value);
    }, entry).catch(() => {});
  };
  page.on("request", (request) => {
    for (const collect of parseAnalyticsCollectRequests(request)) {
      if (!collect.eventName) continue;
      void mirrorCollectEvent({ ...collect, status: "requested" });
    }
  });
  page.on("requestfinished", (request) => {
    for (const collect of parseAnalyticsCollectRequests(request)) {
      if (!collect.eventName) continue;
      void mirrorCollectEvent({ ...collect, status: "finished" });
    }
  });

  await page.goto(`${appOrigin}/login?redirect=${encodeURIComponent("/kai")}`, {
    waitUntil: "domcontentloaded",
  });
  await waitForMeasurementId(page);

  const reviewerButton = page.getByRole("button", { name: /continue as reviewer/i });
  await clickIfVisible(reviewerButton);
  await waitForReviewerVaultBootstrap(page);

  const growthEvent = await waitForAnalyticsEvent(
    page,
    "growth_funnel_step_completed",
    (payload) => payload.journey === "investor" && payload.step === "entered"
  );

  await navigateInApp(page, "/kai/portfolio");
  const portfolioEvent = await waitForAnalyticsEvent(
    page,
    "portfolio_viewed",
    (payload) => payload.result === "success"
  );

  await navigateInApp(
    page,
    `/kai/analysis?ticker=${encodeURIComponent(smokeTicker)}&pickSource=default`
  );
  const startButton = page.getByRole("button", {
    name: /start debate|start analysis|run debate|run analysis|begin debate|begin analysis/i,
  }).first();
  await clickRequired(startButton, "analysis start command");

  const recommendationEvent = await waitForAnalyticsEvent(
    page,
    "recommendation_viewed",
    (payload) => payload.result === "success",
    analysisTimeoutMs
  );
  const activationEvent = await waitForAnalyticsEvent(
    page,
    "investor_activation_completed",
    (payload) => payload.journey === "investor",
    defaultTimeoutMs
  );
  await waitForAnalyticsCollectEvents([
    "growth_funnel_step_completed",
    "portfolio_viewed",
    "recommendation_viewed",
    "investor_activation_completed",
  ]);

  const state = await getSmokeState(page);
  const measurementIds = new Set([
    ...state.measurementIds,
    ...state.scriptMeasurementIds,
    ...analyticsRequestMeasurementIds,
  ]);
  if (!measurementIds.has(expectedMeasurementId)) {
    throw new Error(`measurement ID ${expectedMeasurementId} was not observed`);
  }
  const leaked = [...measurementIds].filter((id) => forbiddenMeasurementIds.has(id));
  if (leaked.length > 0) {
    throw new Error(`forbidden production measurement ID(s) observed: ${leaked.join(", ")}`);
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
                  entry.status !== "failed"
              )
              .map((entry) => entry.eventName)
          ),
        ].sort(),
        observedGaCollectStatuses: analyticsCollectEvents
          .filter((entry) => entry.measurementId === expectedMeasurementId && entry.eventName)
          .map((entry) => ({
            eventName: entry.eventName,
            status: entry.status,
            failureText: entry.failureText,
          })),
        events: {
          growth_funnel_step_completed: growthEvent.payload,
          portfolio_viewed: portfolioEvent.payload,
          recommendation_viewed: recommendationEvent.payload,
          investor_activation_completed: activationEvent.payload,
        },
      },
      null,
      2
    )
  );
} catch (error) {
  const state = await getSmokeState(page).catch(() => ({ events: [], measurementIds: [] }));
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
        observedEventNames: [...new Set((state.events || []).map((entry) => entry.event))],
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
              .map((entry) => `${entry.eventName}:${entry.status}`)
          ),
        ].sort(),
      },
      null,
      2
    )
  );
  process.exitCode = 1;
} finally {
  await context.close().catch(() => {});
  await browser.close().catch(() => {});
}
