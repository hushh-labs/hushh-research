const fs = require("node:fs");
const path = require("node:path");
const dotenv = require("dotenv");
const { test, expect, devices } = require("@playwright/test");

const CONSENT_PROTOCOL_ROOT = path.resolve(process.cwd(), "../consent-protocol");
const ENV_FILES = [
  ".env.local.local",
  ".env.local",
];

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
const PASS = resolveRawPassphrase();
const OUT_DIR = path.resolve(
  process.cwd(),
  process.env.PLAYWRIGHT_OUT_DIR || "/tmp/hushh-audit/ria-audit"
);
const IPHONE_13 = devices["iPhone 13"];

const ROUTES = [
  {
    slug: "ria-home",
    path: "/ria",
    primaryTestId: "ria-home-primary",
    sectionTestIds: ["ria-home-queue", "ria-home-launcher"],
  },
  {
    slug: "ria-clients",
    path: "/ria/clients",
    primaryTestId: "ria-clients-primary",
    sectionTestIds: ["ria-clients-roster", "ria-clients-connected", "ria-clients-pending"],
  },
  {
    slug: "ria-picks",
    path: "/ria/picks",
    primaryTestId: "ria-picks-primary",
    sectionTestIds: ["ria-picks-active", "ria-picks-history"],
  },
  {
    slug: "ria-consent-manager",
    path: "/consents?actor=ria&view=outgoing&tab=pending",
    primaryTestId: "consent-manager-primary",
    sectionTestIds: ["consent-manager-list", "consent-manager-detail"],
  },
];

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

async function ensureReviewerSession(page) {
  await page.goto(`${BASE_URL}/login?redirect=/ria`, { waitUntil: "domcontentloaded" });
  const reviewer = page.getByRole("button", { name: /continue as reviewer/i });
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
      return;
    }
  }
  throw new Error(`Reviewer login did not transition off /login. Final URL: ${page.url()}`);
}

async function unlockIfNeeded(page) {
  if (!PASS) {
    throw new Error("KAI_TEST_PASSPHRASE missing for vault unlock");
  }
  const unlockDialog = page.getByRole("dialog", { name: /unlock vault/i });
  const passphraseField = page.locator("#unlock-passphrase");
  const unlockButton = page.getByRole("button", { name: /unlock with passphrase/i });
  const passphraseFallback = page.getByRole("button", { name: /use passphrase instead/i });
  const retryVaultCheck = page.getByRole("button", { name: /try again/i }).first();

  if (
    !(await unlockDialog.isVisible().catch(() => false)) &&
    !(await passphraseField.isVisible().catch(() => false)) &&
    !(await passphraseFallback.isVisible().catch(() => false))
  ) {
    await Promise.allSettled([
      unlockDialog.waitFor({ state: "visible", timeout: 8000 }),
      passphraseField.waitFor({ state: "visible", timeout: 8000 }),
      passphraseFallback.waitFor({ state: "visible", timeout: 8000 }),
    ]);
  }

  if (
    !(await unlockDialog.isVisible().catch(() => false)) &&
    !(await passphraseField.isVisible().catch(() => false)) &&
    !(await passphraseFallback.isVisible().catch(() => false))
  ) {
    return;
  }

  if (!(await passphraseField.isVisible().catch(() => false))) {
    if (await retryVaultCheck.isVisible().catch(() => false)) {
      await retryVaultCheck.click({ force: true }).catch(() => undefined);
      await page.waitForTimeout(900);
    }
    if (await passphraseFallback.isVisible().catch(() => false)) {
      await expect(passphraseFallback).toBeEnabled({ timeout: 15000 });
      await passphraseFallback.click();
      await expect(passphraseField).toBeVisible({ timeout: 10000 });
    }
  }

  await passphraseField.fill(PASS);
  await unlockButton.click();
  await page.waitForTimeout(1200);
  await expect(unlockDialog).not.toBeVisible({ timeout: 30000 });
}

async function ensureRiaPersona(page) {
  await page.goto(`${BASE_URL}/ria`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  await unlockIfNeeded(page);
  const title = page.locator('[data-testid="top-app-bar-title"]').first();
  await expect(title).toBeVisible({ timeout: 15000 });
  const titleText = ((await title.textContent()) || "").toLowerCase();
  if (!titleText.includes("investor")) {
    return;
  }

  await title.click();
  const riaOption = page.getByRole("menuitem", { name: /^ria$|set up ria/i }).first();
  await expect(riaOption).toBeVisible({ timeout: 10000 });
  await riaOption.click();
  await page.waitForTimeout(1200);
  await expect(page.locator('[data-testid="top-app-bar-title"]')).toContainText(/ria/i);
}

async function measureTopShell(page) {
  const row = page.locator('[data-testid="top-app-bar-row"]');
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

  expect(rowBox).not.toBeNull();
  expect(titleBox).not.toBeNull();
  expect(actionsBox).not.toBeNull();

  return { rowBox, titleBox, actionsBox };
}

async function assertNoHorizontalOverflow(page) {
  const metrics = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.innerWidth + 1);
}

async function captureScrollState(page, filePath, scrollY) {
  await page.evaluate((value) => window.scrollTo(0, value), scrollY);
  await page.waitForTimeout(250);
  await page.screenshot({
    path: filePath,
    fullPage: false,
    animations: "disabled",
  });
  return measureTopShell(page);
}

async function auditRoute(page, variantName, route) {
  await page.goto(`${BASE_URL}${route.path}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  await unlockIfNeeded(page);
  await page.waitForTimeout(900);

  const primary = page.locator(`[data-testid="${route.primaryTestId}"]`).first();
  await expect(primary).toBeVisible({ timeout: 15000 });

  const shellMetrics = await measureTopShell(page);
  const primaryBox = await primary.boundingBox();
  expect(primaryBox).not.toBeNull();
  expect(primaryBox.y).toBeGreaterThanOrEqual(shellMetrics.rowBox.y + shellMetrics.rowBox.height - 2);

  for (const sectionTestId of route.sectionTestIds) {
    const count = await page.locator(`[data-testid="${sectionTestId}"]`).count();
    expect(count).toBeGreaterThan(0);
  }

  await assertNoHorizontalOverflow(page);

  const scrollMetrics = await page.evaluate(() => ({
    maxScrollY: Math.max(
      0,
      document.documentElement.scrollHeight - window.innerHeight
    ),
  }));
  const positions = [
    { label: "top", value: 0 },
    { label: "mid", value: Math.round(scrollMetrics.maxScrollY / 2) },
    { label: "bottom", value: Math.max(0, scrollMetrics.maxScrollY - 24) },
  ];

  const screenshotDir = path.join(OUT_DIR, variantName);
  fs.mkdirSync(screenshotDir, { recursive: true });

  const baselines = [];
  for (const position of positions) {
    const filePath = path.join(screenshotDir, `${route.slug}-${position.label}.png`);
    const metrics = await captureScrollState(page, filePath, position.value);
    baselines.push({
      label: position.label,
      filePath,
      metrics,
    });
  }

  const [initial, ...rest] = baselines;
  for (const entry of rest) {
    expect(
      Math.abs(entry.metrics.titleBox.y - initial.metrics.titleBox.y),
      `${route.slug}:${entry.label} title moved vertically`
    ).toBeLessThanOrEqual(1.5);
    expect(
      Math.abs(entry.metrics.actionsBox.y - initial.metrics.actionsBox.y),
      `${route.slug}:${entry.label} actions moved vertically`
    ).toBeLessThanOrEqual(1.5);
  }

  return {
    path: route.path,
    slug: route.slug,
    screenshots: baselines.map((entry) => ({
      label: entry.label,
      filePath: entry.filePath,
    })),
  };
}

async function discoverWorkspaceRoute(page) {
  await page.goto(`${BASE_URL}/ria/clients`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  await unlockIfNeeded(page);
  await page.waitForTimeout(900);

  const connectedSection = page.locator('[data-testid="ria-clients-connected"]');
  await expect(connectedSection).toBeVisible({ timeout: 15000 });

  const candidateRow = connectedSection.getByRole("button").first();
  if ((await candidateRow.count()) === 0) {
    return null;
  }

  await candidateRow.click();
  const workspaceLink = page.getByRole("link", { name: /open workspace/i }).first();
  if (!(await workspaceLink.isVisible().catch(() => false))) {
    return null;
  }

  const href = await workspaceLink.getAttribute("href");
  return href || null;
}

for (const variant of VARIANTS) {
  test.describe(`${variant.name} RIA audit`, () => {
    test.use(variant.use);

    test(`${variant.name} captures RIA flows`, async ({ page }) => {
      test.setTimeout(180000);
      fs.mkdirSync(OUT_DIR, { recursive: true });

      await installPasskeyBypass(page);
      await ensureReviewerSession(page);
      await ensureRiaPersona(page);

      const report = [];
      for (const route of ROUTES) {
        report.push(await auditRoute(page, variant.name, route));
      }

      const workspacePath = await discoverWorkspaceRoute(page);
      if (workspacePath) {
        report.push(
          await auditRoute(page, variant.name, {
            slug: "ria-workspace",
            path: workspacePath,
            primaryTestId: "ria-workspace-primary",
            sectionTestIds: [
              "ria-workspace-access",
              "ria-workspace-data",
              "ria-workspace-secondary",
            ],
          })
        );
      }

      console.log(
        JSON.stringify(
          {
            variant: variant.name,
            workspacePath,
            report,
          },
          null,
          2
        )
      );
    });
  });
}
