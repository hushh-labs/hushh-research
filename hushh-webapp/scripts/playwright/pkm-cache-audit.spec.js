const fs = require("node:fs");
const path = require("node:path");
const dotenv = require("dotenv");
const { test, expect, devices } = require("@playwright/test");

const CONSENT_PROTOCOL_ROOT = path.resolve(process.cwd(), "../consent-protocol");
const ENV_FILES = [".env.local.local", ".env.local"];

ENV_FILES.forEach((fileName) => {
  const envPath = path.join(CONSENT_PROTOCOL_ROOT, fileName);
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath, override: false });
  }
});

function resolveRawPassphrase() {
  for (const fileName of ENV_FILES) {
    const envPath = path.join(CONSENT_PROTOCOL_ROOT, fileName);
    if (!fs.existsSync(envPath)) continue;
    const source = fs.readFileSync(envPath, "utf8");
    const match = source.match(/^KAI_TEST_PASSPHRASE=(.+)$/m);
    if (match?.[1]) {
      return match[1].trim();
    }
  }
  return process.env.KAI_TEST_PASSPHRASE || "";
}

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const BASE_ORIGIN = new URL(BASE_URL).origin;
const PASS = resolveRawPassphrase();
const OUT_DIR = path.resolve(
  process.cwd(),
  process.env.PLAYWRIGHT_OUT_DIR || "/tmp/hushh-audit/pkm-cache-audit"
);
const IPHONE_13 = devices["iPhone 13"];

const VARIANTS = [
  {
    name: "desktop",
    use: {
      viewport: { width: 1440, height: 1100 },
    },
  },
  {
    name: "mobile",
    use: {
      viewport: IPHONE_13.viewport,
      userAgent: IPHONE_13.userAgent,
      deviceScaleFactor: IPHONE_13.deviceScaleFactor,
      isMobile: IPHONE_13.isMobile,
      hasTouch: IPHONE_13.hasTouch,
    },
  },
];

function slugify(input) {
  return String(input || "")
    .replace(/^\//, "")
    .replace(/[/?=&]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

async function installPasskeyBypass(page) {
  await page.addInitScript(() => {
    if (!navigator.credentials?.get) return;
    const originalGet = navigator.credentials.get.bind(navigator.credentials);
    navigator.credentials.get = async (...args) => {
      const [options] = args;
      if (options && typeof options === "object" && "publicKey" in options) {
        throw new DOMException("Playwright audit bypassed passkey prompt", "NotAllowedError");
      }
      return originalGet(...args);
    };
  });
}

async function gotoStable(page, routePath) {
  let lastError = null;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await page.goto(`${BASE_URL}${routePath}`, { waitUntil: "domcontentloaded" });
      return;
    } catch (error) {
      lastError = error;
      if (!/ERR_ABORTED/i.test(String(error))) {
        throw error;
      }
      await page.waitForTimeout(800);
    }
  }

  throw lastError || new Error(`Failed to navigate to ${routePath}`);
}

async function waitForReviewModeConfig(page) {
  const response = await page
    .waitForResponse(
      (candidate) =>
        candidate.url().includes("/api/app-config/review-mode") &&
        candidate.request().method() === "GET",
      { timeout: 20000 }
    )
    .catch(() => null);

  if (!response) {
    return null;
  }

  if (!response.ok()) {
    throw new Error(`Review mode config request failed with HTTP ${response.status()}`);
  }

  return await response.json().catch(() => null);
}

async function ensureReviewerSession(page) {
  await gotoStable(page, "/login?redirect=/kai");

  if (!new URL(page.url()).pathname.startsWith("/login")) {
    return { bootstrap: "already_authenticated" };
  }

  const reviewConfig = await waitForReviewModeConfig(page);
  if (!new URL(page.url()).pathname.startsWith("/login")) {
    return { bootstrap: "already_authenticated" };
  }

  const reviewer = page.getByRole("button", { name: /continue as reviewer/i });
  const reviewerVisible = await reviewer.isVisible().catch(() => false);
  if (reviewConfig?.enabled === false && !reviewerVisible) {
    throw new Error("Review mode is unavailable for the PKM cache audit session.");
  }

  await expect(reviewer).toBeVisible({ timeout: 15000 });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const sessionResponsePromise = page
      .waitForResponse(
        (candidate) =>
          candidate.url().includes("/api/app-config/review-mode/session") &&
          candidate.request().method() === "POST",
        { timeout: 10000 }
      )
      .catch(() => null);

    await reviewer.click({ force: true }).catch(() => undefined);
    const sessionResponse = await sessionResponsePromise;
    if (sessionResponse && !sessionResponse.ok()) {
      throw new Error(
        `Reviewer session bootstrap failed with HTTP ${sessionResponse.status()}`
      );
    }

    const transitioned = await page
      .waitForFunction(() => !window.location.pathname.startsWith("/login"), null, {
        timeout: 15000,
      })
      .then(() => true)
      .catch(() => false);
    if (transitioned) {
      await page.waitForTimeout(1200);
      return { bootstrap: "reviewer_login" };
    }
  }

  throw new Error(`Reviewer login did not transition off /login. Final URL: ${page.url()}`);
}

async function snapshotUnlockState(page) {
  return await page.evaluate(() => {
    const selectors = ['[role="dialog"]', "#unlock-passphrase", "button", "input"];
    const textPreview = Array.from(document.querySelectorAll("button, [role='dialog']"))
      .map((node) => (node.textContent || "").trim())
      .filter(Boolean)
      .slice(0, 12);

    return {
      pathname: window.location.pathname + window.location.search,
      visibleSelectors: selectors.filter((selector) => {
        const element = document.querySelector(selector);
        if (!element) return false;
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      }),
      textPreview,
    };
  });
}

async function unlockIfNeeded(page) {
  if (!PASS) {
    throw new Error("KAI_TEST_PASSPHRASE missing for vault unlock");
  }

  const unlockDialog = page.getByRole("dialog", { name: /unlock vault/i });
  const inlineUnlockButton = page.getByRole("button", { name: /^unlock vault$/i }).first();
  const lockedBadge = page.getByText(/vault locked/i).first();
  const passphraseField = page.locator("#unlock-passphrase");
  const unlockButton = page.getByRole("button", { name: /unlock with passphrase/i });
  const passphraseFallback = page.getByRole("button", { name: /use passphrase/i });
  const retryVaultCheck = page.getByRole("button", { name: /try again/i }).first();
  const checkingVault = page.getByText(/checking vault|opening your vault/i).first();
  const mainContent = page.locator("main").first();

  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (await checkingVault.isVisible().catch(() => false)) {
      await page.waitForTimeout(2000);
      continue;
    }

    const dialogVisible = await unlockDialog.isVisible().catch(() => false);
    const fieldVisible = await passphraseField.isVisible().catch(() => false);
    const fallbackVisible = await passphraseFallback.isVisible().catch(() => false);
    const mainVisible = await mainContent.isVisible().catch(() => false);
    const unlockButtonVisible = await unlockButton.isVisible().catch(() => false);
    const inlineUnlockVisible = await inlineUnlockButton.isVisible().catch(() => false);
    const lockedBadgeVisible = await lockedBadge.isVisible().catch(() => false);
    const retryVisible = await retryVaultCheck.isVisible().catch(() => false);

    if ((inlineUnlockVisible || lockedBadgeVisible) && !fieldVisible) {
      if (inlineUnlockVisible) {
        await inlineUnlockButton.click({ force: true }).catch(() => undefined);
        await page.waitForTimeout(700);
        continue;
      }
    }

    if (retryVisible) {
      await retryVaultCheck.click({ force: true }).catch(() => undefined);
      await page.waitForTimeout(900);
      continue;
    }

    if (!dialogVisible && !fieldVisible && !fallbackVisible && mainVisible) {
      return { state: "already_unlocked" };
    }

    if (!fieldVisible && fallbackVisible) {
      await passphraseFallback.click({ force: true }).catch(() => undefined);
      await page.waitForTimeout(600);
      continue;
    }

    if (!fieldVisible && unlockButtonVisible) {
      await unlockButton.click({ force: true }).catch(() => undefined);
      await page.waitForTimeout(600);
      continue;
    }

    if (dialogVisible && !fieldVisible && !fallbackVisible && !unlockButtonVisible) {
      await page.waitForTimeout(1500);
      continue;
    }

    if (fieldVisible) {
      await passphraseField.fill(PASS);
      if (unlockButtonVisible) {
        await expect(unlockButton).toBeEnabled({ timeout: 10000 });
        await unlockButton.click();
      } else {
        await passphraseField.press("Enter").catch(() => undefined);
      }
      await page.waitForTimeout(1500);

      if (
        !(await unlockDialog.isVisible().catch(() => false)) &&
        !(await passphraseField.isVisible().catch(() => false))
      ) {
        return { state: "unlocked_with_passphrase" };
      }
    }

    await page.waitForTimeout(700);
  }

  const snapshot = await snapshotUnlockState(page);
  const hasUnlockChrome =
    snapshot.visibleSelectors.includes('[role="dialog"]') ||
    snapshot.visibleSelectors.includes("#unlock-passphrase");
  if (!hasUnlockChrome) {
    return { state: "no_unlock_ui_detected" };
  }
  throw new Error(`Vault unlock did not complete. Snapshot: ${JSON.stringify(snapshot)}`);
}

async function waitForRouteSurface(page) {
  const anchor = page.locator('[data-top-content-anchor="true"]').first();
  const blockingLoaders = [
    page.getByText(/loading kai/i).first(),
    page.getByText(/loading onboarding/i).first(),
    page.getByText(/loading marketplace/i).first(),
    page.getByText(/checking vault|opening your vault/i).first(),
  ];

  for (let attempt = 0; attempt < 10; attempt += 1) {
    await unlockIfNeeded(page);

    if (await anchor.isVisible().catch(() => false)) {
      return;
    }

    const anyLoaderVisible = await Promise.all(
      blockingLoaders.map((locator) => locator.isVisible().catch(() => false))
    );
    if (anyLoaderVisible.some(Boolean)) {
      await page.waitForTimeout(1000);
      continue;
    }

    const mainVisible = await page.locator("main").first().isVisible().catch(() => false);
    if (mainVisible) {
      return;
    }

    await page.waitForTimeout(700);
  }
}

function attachAudit(page) {
  const requests = [];
  const resourceEvents = [];
  const marketSymbols = [];
  const pendingParses = [];

  const requestListener = (request) => {
    try {
      const url = new URL(request.url());
      if (url.origin !== BASE_ORIGIN) return;
      if (!url.pathname.startsWith("/api/")) return;
      requests.push({
        method: request.method(),
        pathname: url.pathname,
        url: `${url.pathname}${url.search}`,
      });
    } catch {
      // ignore malformed URLs
    }
  };

  const responseListener = (response) => {
    const parsePromise = (async () => {
      try {
        const url = new URL(response.url());
        if (url.origin !== BASE_ORIGIN) return;
        if (
          !url.pathname.startsWith("/api/kai/market/insights/") &&
          !url.pathname.startsWith("/api/kai/market/insights/baseline/")
        ) {
          return;
        }
        if (!response.ok()) return;
        const payload = await response.json().catch(() => null);
        const candidateSets = [
          ...(Array.isArray(payload?.spotlights) ? payload.spotlights : []),
          ...(Array.isArray(payload?.pick_rows) ? payload.pick_rows : []),
          ...(Array.isArray(payload?.renaissance_list) ? payload.renaissance_list : []),
        ];
        for (const row of candidateSets) {
          const symbol = String(row?.symbol || "").trim().toUpperCase();
          if (symbol && !marketSymbols.includes(symbol)) {
            marketSymbols.push(symbol);
          }
        }
      } catch {
        // ignore parse errors
      }
    })();
    pendingParses.push(parsePromise);
  };

  const consoleListener = (message) => {
    const text = message.text();
    if (!text.startsWith("[RequestAudit:")) return;

    const parsePromise = (async () => {
      const match = text.match(/^\[RequestAudit:([^\]]+)\]\s+([a-z_]+)/i);
      if (!match) return;
      let detail = null;
      const args = message.args();
      if (args.length > 1) {
        detail = await args[1].jsonValue().catch(() => null);
      }
      resourceEvents.push({
        label: match[1],
        stage: match[2],
        detail,
      });
    })();

    pendingParses.push(parsePromise);
  };

  page.on("request", requestListener);
  page.on("response", responseListener);
  page.on("console", consoleListener);

  return {
    async drain() {
      await Promise.allSettled(pendingParses);
      page.off("request", requestListener);
      page.off("response", responseListener);
      page.off("console", consoleListener);
      return {
        requests,
        resourceEvents,
        marketSymbols,
      };
    },
  };
}

function summarizeRequests(records) {
  const grouped = new Map();

  for (const record of records) {
    const key = `${record.method} ${record.pathname}`;
    const next = grouped.get(key) || { count: 0, urls: new Set() };
    next.count += 1;
    next.urls.add(record.url);
    grouped.set(key, next);
  }

  const duplicates = [];
  for (const [key, value] of grouped.entries()) {
    if (value.count > 1) {
      duplicates.push({
        key,
        count: value.count,
        urls: Array.from(value.urls),
      });
    }
  }

  return {
    total: records.length,
    duplicates,
  };
}

function summarizeResourceEvents(events) {
  const byLabel = {};

  for (const event of events) {
    if (!byLabel[event.label]) {
      byLabel[event.label] = {
        total: 0,
        stages: {},
        firstSignal: null,
      };
    }
    const target = byLabel[event.label];
    target.total += 1;
    target.stages[event.stage] = (target.stages[event.stage] || 0) + 1;

    if (
      !target.firstSignal &&
      [
        "cache_hit",
        "stale_hit",
        "device_hit",
        "revision_match_hit",
        "cache_miss",
        "network_fetch",
      ].includes(event.stage)
    ) {
      target.firstSignal = {
        stage: event.stage,
        detail: event.detail,
      };
    }
  }

  return byLabel;
}

async function captureScreenshot(page, variantName, slug, label) {
  const dir = path.join(OUT_DIR, variantName);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${slug}-${label}.png`);
  await page.screenshot({
    path: filePath,
    fullPage: false,
    animations: "disabled",
  });
  return filePath;
}

async function auditTransition(page, variantName, params) {
  console.log(`[pkm-cache-audit] ${variantName} -> ${params.slug}:${params.phase} start`);
  const collector = attachAudit(page);
  const startedAt = Date.now();

  await params.action();
  await page.waitForURL(params.urlPattern, { timeout: 90000 });
  await page.waitForTimeout(900);
  await waitForRouteSurface(page);
  await page.waitForTimeout(900);

  const audit = await collector.drain();
  const screenshotPath = await captureScreenshot(page, variantName, params.slug, params.phase);

  return {
    slug: params.slug,
    phase: params.phase,
    finalPath: new URL(page.url()).pathname + new URL(page.url()).search,
    durationMs: Date.now() - startedAt,
    screenshotPath,
    requestAudit: summarizeRequests(audit.requests),
    resourceAudit: summarizeResourceEvents(audit.resourceEvents),
    marketSymbols: audit.marketSymbols,
  };
}

async function clickBottomNav(page, tourId) {
  const target = page.locator(`[data-tour-id="${tourId}"]`).first();
  await expect(target).toBeVisible({ timeout: 15000 });
  await target.click();
}

async function runPkmLabPreview(page, variantName) {
  console.log(`[pkm-cache-audit] ${variantName} -> pkm-agent-lab preview start`);
  const collector = attachAudit(page);
  await gotoStable(page, "/profile/pkm-agent-lab");
  await page.waitForTimeout(1200);
  await waitForRouteSurface(page);
  await page
    .getByText(/loading developer access and pkm metadata/i)
    .first()
    .waitFor({ state: "hidden", timeout: 30000 })
    .catch(() => undefined);
  await unlockIfNeeded(page);

  const toolTab = page.getByRole("button", { name: /^tool$/i });
  if (await toolTab.isVisible().catch(() => false)) {
    await toolTab.click();
  }

  const accessWarning = page.getByText(/developer access is required for this tool/i).first();
  if (await accessWarning.isVisible().catch(() => false)) {
    throw new Error("PKM Agent Lab is visible, but developer access is not enabled for the Kai test user.");
  }

  const textarea = page.locator("textarea").first();
  const previewButton = page.getByRole("button", { name: /preview pkm structure/i });
  await expect(textarea).toBeVisible({ timeout: 15000 });
  await expect(previewButton).toBeVisible({ timeout: 15000 });

  await textarea.fill(
    "Remember that I prefer short city breaks, weekly meal prep, and concise portfolio explanations."
  );

  const responsePromise = page.waitForResponse(
    (response) =>
      response.url().includes("/api/pkm/agent-lab/structure") &&
      response.request().method() === "POST",
    { timeout: 45000 }
  );

  await previewButton.click();
  const response = await responsePromise.catch(() => null);
  if (response) {
    expect(response.ok()).toBeTruthy();
    await expect(page.getByText(/pkm update preview/i).first()).toBeVisible({ timeout: 45000 });
  } else {
    console.warn(`[pkm-cache-audit] ${variantName} -> pkm-agent-lab preview timed out`);
  }

  const audit = await collector.drain();
  const screenshotPath = await captureScreenshot(page, variantName, "pkm-agent-lab", "preview");
  const summary = await page.evaluate(() => {
    const preview = Array.from(document.querySelectorAll("span, p, h2"))
      .map((node) => (node.textContent || "").trim())
      .filter(Boolean);
    return preview.filter((text) =>
      /preview time:|preview cards?|can save|confirm first|do not save|Context plan:/i.test(text)
    );
  });

  return {
    finalPath: new URL(page.url()).pathname + new URL(page.url()).search,
    screenshotPath,
    previewTimedOut: !response,
    previewSummary: summary,
    requestAudit: summarizeRequests(audit.requests),
    resourceAudit: summarizeResourceEvents(audit.resourceEvents),
  };
}

for (const variant of VARIANTS) {
  test.describe(`${variant.name} PKM cache audit`, () => {
    test.use(variant.use);

    test(`${variant.name} validates PKM-first cache reuse through the Kai signed-in flow`, async ({ page }) => {
      test.setTimeout(360000);
      fs.mkdirSync(OUT_DIR, { recursive: true });

      console.log(`[pkm-cache-audit] ${variant.name} -> bootstrap start`);
      await installPasskeyBypass(page);
      const authBootstrap = await ensureReviewerSession(page);
      const vaultBootstrap = await unlockIfNeeded(page);
      console.log(
        `[pkm-cache-audit] ${variant.name} -> bootstrap ready auth=${authBootstrap.bootstrap} vault=${vaultBootstrap.state}`
      );
      const pkmLab = await runPkmLabPreview(page, variant.name);

      const report = [];

      report.push(
        await auditTransition(page, variant.name, {
          slug: "kai-market",
          phase: "cold",
          urlPattern: /\/kai(?:\?|$)/,
          action: async () => {
            await clickBottomNav(page, "nav-market");
          },
        })
      );

      report.push(
        await auditTransition(page, variant.name, {
          slug: "kai-portfolio",
          phase: "cold",
          urlPattern: /\/kai\/portfolio(?:\?|$)/,
          action: async () => {
            await clickBottomNav(page, "nav-portfolio");
          },
        })
      );

      report.push(
        await auditTransition(page, variant.name, {
          slug: "kai-analysis",
          phase: "cold",
          urlPattern: /\/kai\/analysis(?:\?|$)/,
          action: async () => {
            await clickBottomNav(page, "nav-analysis");
          },
        })
      );

      report.push(
        await auditTransition(page, variant.name, {
          slug: "kai-market",
          phase: "warm",
          urlPattern: /\/kai(?:\?|$)/,
          action: async () => {
            await clickBottomNav(page, "nav-market");
          },
        })
      );

      report.push(
        await auditTransition(page, variant.name, {
          slug: "kai-portfolio",
          phase: "warm",
          urlPattern: /\/kai\/portfolio(?:\?|$)/,
          action: async () => {
            await clickBottomNav(page, "nav-portfolio");
          },
        })
      );

      report.push(
        await auditTransition(page, variant.name, {
          slug: "kai-market",
          phase: "hard-reload",
          urlPattern: /\/kai(?:\?|$)/,
          action: async () => {
            await gotoStable(page, "/kai");
          },
        })
      );

      const reportPath = path.join(OUT_DIR, `${variant.name}-report.json`);
      fs.writeFileSync(
        reportPath,
        JSON.stringify(
          {
            variant: variant.name,
            baseUrl: BASE_URL,
            authBootstrap,
            vaultBootstrap,
            pkmLab,
            routes: report,
          },
          null,
          2
        )
      );

      console.log(
        JSON.stringify(
          {
            variant: variant.name,
            authBootstrap,
            vaultBootstrap,
            reportPath,
          },
          null,
          2
        )
      );
    });
  });
}
