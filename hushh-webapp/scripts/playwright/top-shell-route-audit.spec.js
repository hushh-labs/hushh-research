const fs = require("node:fs");
const path = require("node:path");
const dotenv = require("dotenv");
const { test, expect, devices } = require("@playwright/test");

const CONSENT_PROTOCOL_ROOT = path.resolve(process.cwd(), "../consent-protocol");
const ENV_FILES = [".env.local.local", ".env.local"];
const ROUTE_LAYOUT_CONTRACT = require(path.resolve(
  process.cwd(),
  "lib/navigation/app-route-layout.contract.json"
));

ENV_FILES.forEach((fileName) => {
  const envPath = path.join(CONSENT_PROTOCOL_ROOT, fileName);
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath, override: false });
  }
});

function resolveRawPassphrase() {
  for (const fileName of ENV_FILES) {
    const envPath = path.join(CONSENT_PROTOCOL_ROOT, fileName);
    if (!fs.existsSync(envPath)) {
      continue;
    }

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
  process.env.PLAYWRIGHT_OUT_DIR || "/tmp/hushh-audit/top-shell-route-audit"
);
const IPHONE_13 = devices["iPhone 13"];

const DISCOVERABLE_ROUTE_FACTORIES = {
  "/marketplace/ria": discoverMarketplaceProfileRoute,
  "/ria/workspace": discoverWorkspaceRoute,
};

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

function slugFromRoute(routePath) {
  if (routePath === "/") return "root";
  return routePath
    .replace(/^\//, "")
    .replace(/[/?=&]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function buildAuditRouteCandidates() {
  return ROUTE_LAYOUT_CONTRACT.filter((entry) => entry.mode !== "hidden").map((entry) => ({
    route: entry.route,
    slug: slugFromRoute(entry.route),
    mode: entry.mode,
  }));
}

async function installPasskeyBypass(page) {
  await page.addInitScript(() => {
    if (!navigator.credentials?.get) {
      return;
    }

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
    throw new Error("Review mode is unavailable for the shell audit session.");
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
    const selectors = [
      '[role="dialog"]',
      '#unlock-passphrase',
      'button',
      'input',
    ];
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
  const passphraseField = page.locator("#unlock-passphrase");
  const unlockButton = page.getByRole("button", { name: /unlock with passphrase/i });
  const passphraseFallback = page.getByRole("button", { name: /use passphrase/i });
  const retryVaultCheck = page.getByRole("button", { name: /try again/i }).first();
  const checkingVault = page.getByText(/checking vault/i).first();
  const mainContent = page.locator("main").first();

  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (await checkingVault.isVisible().catch(() => false)) {
      await page.waitForTimeout(800);
      continue;
    }

    const dialogVisible = await unlockDialog.isVisible().catch(() => false);
    const fieldVisible = await passphraseField.isVisible().catch(() => false);
    const fallbackVisible = await passphraseFallback.isVisible().catch(() => false);
    const mainVisible = await mainContent.isVisible().catch(() => false);
    const unlockButtonVisible = await unlockButton.isVisible().catch(() => false);
    const retryVisible = await retryVaultCheck.isVisible().catch(() => false);

    if (!dialogVisible && !fieldVisible && !fallbackVisible && mainVisible) {
      return { state: "already_unlocked" };
    }

    if (retryVisible) {
      await retryVaultCheck.click({ force: true }).catch(() => undefined);
      await page.waitForTimeout(900);
      continue;
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

async function discoverWorkspaceRoute(page) {
  try {
    await gotoStable(page, "/ria/clients");
    await page.waitForTimeout(1200);
    await unlockIfNeeded(page);
    await page.waitForTimeout(800);

    const connectedSection = page.locator('[data-testid="ria-clients-connected"]');
    if (!(await connectedSection.isVisible().catch(() => false))) {
      return null;
    }

    const candidateRow = connectedSection.getByRole("button").first();
    if ((await candidateRow.count()) === 0) {
      return null;
    }

    await candidateRow.click();
    const workspaceLink = page.getByRole("link", { name: /open workspace/i }).first();
    if (!(await workspaceLink.isVisible().catch(() => false))) {
      return null;
    }

    return await workspaceLink.getAttribute("href");
  } catch (error) {
    console.warn("[top-shell-route-audit] Workspace discovery skipped:", error);
    return null;
  }
}

async function discoverMarketplaceProfileRoute(page) {
  try {
    await gotoStable(page, "/marketplace");
    await page.waitForTimeout(1200);
    await unlockIfNeeded(page);
    await page.waitForTimeout(800);

    const profileLink = page.locator('a[href^="/marketplace/ria?riaId="]').first();
    if (!(await profileLink.isVisible().catch(() => false))) {
      return null;
    }

    return await profileLink.getAttribute("href");
  } catch (error) {
    console.warn("[top-shell-route-audit] Marketplace profile discovery skipped:", error);
    return null;
  }
}

async function resolveAuditRoutes(page) {
  const routes = [];
  for (const candidate of buildAuditRouteCandidates()) {
    const discovery = DISCOVERABLE_ROUTE_FACTORIES[candidate.route];
    if (discovery) {
      const discoveredPath = await discovery(page);
      if (!discoveredPath) {
        continue;
      }
      routes.push({
        ...candidate,
        path: discoveredPath,
      });
      continue;
    }

    routes.push({
      ...candidate,
      path: candidate.route,
    });
  }
  return routes;
}

async function waitForRouteSurface(page) {
  const anchor = page.locator('[data-top-content-anchor="true"]').first();
  const blockingLoaders = [
    page.getByText(/loading kai/i).first(),
    page.getByText(/loading onboarding/i).first(),
    page.getByText(/loading marketplace/i).first(),
    page.getByText(/checking vault/i).first(),
  ];

  for (let attempt = 0; attempt < 8; attempt += 1) {
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

    await page.waitForTimeout(700);
  }
}

async function assertNoHorizontalOverflow(page) {
  const metrics = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.innerWidth + 1);
}

async function measureTopShell(page) {
  const row = page.locator('[data-testid="top-app-bar-row"]').first();
  const title = page.locator('[data-testid="top-app-bar-title"]').first();
  const actions = page.locator('[data-testid="top-app-bar-actions"]').first();

  await expect(row).toBeVisible({ timeout: 15000 });
  await expect(title).toBeVisible({ timeout: 15000 });
  await expect(actions).toBeVisible({ timeout: 15000 });

  const [rowBox, titleBox, actionsBox] = await Promise.all([
    row.boundingBox(),
    title.boundingBox(),
    actions.boundingBox(),
  ]);

  return { rowBox, titleBox, actionsBox };
}

async function measureFirstMeaningfulContent(page) {
  return await page.evaluate(() => {
    const rootStyles = getComputedStyle(document.documentElement);
    const anchor =
      document.querySelector('[data-top-content-anchor="true"]') ||
      document.querySelector('[data-fullscreen-flow-shell="true"]') ||
      document.querySelector("main");
    const row = document.querySelector('[data-testid="top-app-bar-row"]');

    if (!anchor || !row) {
      return null;
    }

    const candidates = [
      ...anchor.querySelectorAll(
        '[data-testid="page-primary-module"], [data-slot="page-header"], h1, h2, section, article, .surface-card, .surface-stack > *, main > *, div'
      ),
    ];

    const isVisible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const rect = element.getBoundingClientRect();
      const styles = getComputedStyle(element);
      return (
        rect.width > 24 &&
        rect.height > 12 &&
        styles.visibility !== "hidden" &&
        styles.display !== "none" &&
        styles.opacity !== "0"
      );
    };

    const firstMeaningful = candidates.find(isVisible) || anchor;
    const firstRect = firstMeaningful.getBoundingClientRect();
    const anchorRect = anchor.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    const parse = (name) => Number.parseFloat(rootStyles.getPropertyValue(name)) || 0;

    return {
      anchorTop: anchorRect.top,
      firstMeaningfulTop: firstRect.top,
      firstMeaningfulBottom: firstRect.bottom,
      rowBottom: rowRect.bottom,
      topShellVisualHeight: parse("--top-shell-visual-height"),
      topContentOffset: parse("--app-top-content-offset"),
      topMaskTailClearance: parse("--app-top-mask-tail-clearance"),
      firstTagName: firstMeaningful.tagName.toLowerCase(),
      firstTestId: firstMeaningful.getAttribute("data-testid"),
    };
  });
}

async function captureScrollStates(page, variantName, slug) {
  const screenshotDir = path.join(OUT_DIR, variantName);
  fs.mkdirSync(screenshotDir, { recursive: true });

  const captures = [];
  const positions = [
    { label: "top", ratio: 0 },
    { label: "mid", ratio: 0.5 },
    { label: "bottom", ratio: 1 },
  ];

  for (const position of positions) {
    await page.evaluate((ratio) => {
      const maxScroll =
        document.documentElement.scrollHeight - window.innerHeight;
      window.scrollTo({
        top: Math.max(0, Math.floor(maxScroll * ratio)),
        behavior: "auto",
      });
    }, position.ratio);
    await page.waitForTimeout(250);

    const filePath = path.join(screenshotDir, `${slug}-${position.label}.png`);
    await page.screenshot({
      path: filePath,
      fullPage: false,
      animations: "disabled",
    });
    captures.push({
      label: position.label,
      filePath,
    });
  }

  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "auto" }));
  return captures;
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

async function auditRoute(page, variantName, route) {
  const requestRecords = [];
  const requestListener = (request) => {
    try {
      const url = new URL(request.url());
      if (url.origin !== BASE_ORIGIN) return;
      if (!url.pathname.startsWith("/api/")) return;
      requestRecords.push({
        method: request.method(),
        url: `${url.pathname}${url.search}`,
        pathname: url.pathname,
      });
    } catch {
      // ignore malformed URLs
    }
  };

  page.on("request", requestListener);
  try {
    await gotoStable(page, route.path);
    await page.waitForTimeout(1200);
    await waitForRouteSurface(page);
    await page.waitForTimeout(600);

    await expect(page).not.toHaveURL(/\/login(?:\?|$)/, { timeout: 15000 });

    const shellMetrics = await measureTopShell(page);
    const contentMetrics = await measureFirstMeaningfulContent(page);

    expect(contentMetrics).not.toBeNull();
    expect(shellMetrics.titleBox).not.toBeNull();
    expect(shellMetrics.actionsBox).not.toBeNull();
    expect(
      contentMetrics.firstMeaningfulTop,
      `${route.slug} content begins inside the top-shell fade zone`
    ).toBeGreaterThanOrEqual(contentMetrics.rowBottom + 8);
    expect(
      contentMetrics.firstMeaningfulTop,
      `${route.slug} content begins above the provider-owned top offset`
    ).toBeGreaterThanOrEqual(contentMetrics.topShellVisualHeight + 4);

    expect(
      Math.abs(shellMetrics.titleBox.y - shellMetrics.actionsBox.y),
      `${route.slug} top-app-bar title and actions are vertically misaligned`
    ).toBeLessThanOrEqual(2);

    await assertNoHorizontalOverflow(page);
    const captures = await captureScrollStates(page, variantName, route.slug);

    return {
      slug: route.slug,
      requestedPath: route.path,
      finalPath: new URL(page.url()).pathname + new URL(page.url()).search,
      mode: route.mode,
      captures,
      shellMetrics,
      contentMetrics,
      requestAudit: summarizeRequests(requestRecords),
    };
  } finally {
    page.off("request", requestListener);
  }
}

for (const variant of VARIANTS) {
  test.describe(`${variant.name} top shell route audit`, () => {
    test.use(variant.use);

    test(`${variant.name} keeps signed-in route content clear of the top-shell fade`, async ({ page }) => {
      test.setTimeout(360000);
      fs.mkdirSync(OUT_DIR, { recursive: true });

      await installPasskeyBypass(page);
      const authBootstrap = await ensureReviewerSession(page);
      const vaultBootstrap = await unlockIfNeeded(page);
      const routes = await resolveAuditRoutes(page);

      const report = [];
      for (const route of routes) {
        report.push(await auditRoute(page, variant.name, route));
      }

      const reportPath = path.join(OUT_DIR, `${variant.name}-report.json`);
      fs.writeFileSync(
        reportPath,
        JSON.stringify(
          {
            variant: variant.name,
            authBootstrap,
            vaultBootstrap,
            routeCount: report.length,
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
            routeCount: report.length,
            reportPath,
          },
          null,
          2
        )
      );
    });
  });
}
