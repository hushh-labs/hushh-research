const fs = require("fs");
const path = require("path");
const { test, expect } = require("@playwright/test");

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const PASS = process.env.KAI_TEST_PASSPHRASE || "";
const OUT_DIR = process.env.PLAYWRIGHT_OUT_DIR || "/tmp/playwright-topbar-check";

async function ensureReviewerSession(page) {
  await page.goto(`${BASE_URL}/login?redirect=/consents`, { waitUntil: "networkidle" });
  const reviewer = page.getByRole("button", { name: /continue as reviewer/i });
  await expect(reviewer).toBeVisible({ timeout: 15000 });
  await reviewer.click();
  await page.waitForLoadState("networkidle");
}

async function unlockIfNeeded(page) {
  const heading = page.getByRole("heading", { name: /unlock your vault/i });
  if (!(await heading.isVisible().catch(() => false))) return;
  if (!PASS) {
    throw new Error("KAI_TEST_PASSPHRASE missing for vault unlock");
  }
  await page.locator("#unlock-passphrase").fill(PASS);
  await page.getByRole("button", { name: /unlock with passphrase/i }).click();
  await page.waitForLoadState("networkidle");
}

async function captureRoute(page, routePath, slug) {
  await page.goto(`${BASE_URL}${routePath}`, { waitUntil: "networkidle" });
  await unlockIfNeeded(page);
  await page.waitForTimeout(1200);

  const breadcrumbRow = page.locator('[data-testid="top-app-bar-breadcrumb-row"]');
  const pill = breadcrumbRow.locator(".pointer-events-auto").first();
  await expect(breadcrumbRow).toBeVisible({ timeout: 15000 });
  await expect(pill).toBeVisible({ timeout: 15000 });

  const screenshotPath = path.join(OUT_DIR, `${slug}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: false });

  const viewport = page.viewportSize();
  const breadcrumbBox = await pill.boundingBox();

  return {
    routePath,
    screenshotPath,
    viewport,
    breadcrumbBox,
    breadcrumbCenterDelta:
      breadcrumbBox && viewport
        ? Number(((breadcrumbBox.x + breadcrumbBox.width / 2) - viewport.width / 2).toFixed(2))
        : null,
  };
}

test("capture top shell breadcrumb geometry", async ({ page }) => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  await ensureReviewerSession(page);

  const consent = await captureRoute(page, "/consents", "consents");
  const pkm = await captureRoute(page, "/profile/pkm-agent-lab", "pkm-agent-lab");

  console.log(JSON.stringify({ consent, pkm }, null, 2));
});
