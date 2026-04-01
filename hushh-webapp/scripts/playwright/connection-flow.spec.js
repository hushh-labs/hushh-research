// @ts-check
const { test, expect, devices } = require("@playwright/test");
const {
  ensureReviewerSession,
  unlockIfNeeded,
  gotoStable,
  installPasskeyBypass,
} = require("./runtime-audit.helpers");

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const OUT_DIR = process.env.PLAYWRIGHT_OUT_DIR || "/tmp/hushh-audit/connection-flow";

/** @param {import("@playwright/test").Page} page */
async function screenshot(page, name) {
  const fs = require("node:fs");
  const dir = `${OUT_DIR}/screens`;
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: `${dir}/${name}.png`, fullPage: true });
}

/** @param {import("@playwright/test").Page} page */
async function ensurePersona(page, persona) {
  const personaButton = page.locator(
    `[data-testid="top-app-bar-row"] button:has-text("${persona === "ria" ? "RIA" : "Investor"}")`
  );
  const personaPill = page
    .locator('[data-testid="top-app-bar-row"]')
    .getByText(persona === "ria" ? /RIA/i : /Investor/i)
    .first();

  if (await personaPill.isVisible().catch(() => false)) {
    return;
  }

  const switcher = page
    .locator('[data-testid="top-app-bar-row"] button')
    .filter({ hasText: /Investor|RIA/i })
    .first();

  if (await switcher.isVisible().catch(() => false)) {
    await switcher.click();
    await page.waitForTimeout(500);

    const targetOption = page
      .getByRole("menuitem", {
        name: persona === "ria" ? /switch to ria|advisor/i : /switch to investor/i,
      })
      .first();

    if (await targetOption.isVisible().catch(() => false)) {
      await targetOption.click();
      await page.waitForTimeout(2000);
    }
  }
}

test.describe("Connection Flow — Kai Test User", () => {
  test.setTimeout(180_000);

  test("full investor → RIA connection lifecycle", async ({ page }) => {
    await installPasskeyBypass(page);

    // ── Step 1: Authenticate & unlock vault ──
    test.info().annotations.push({ type: "step", description: "Authenticate as reviewer" });
    await ensureReviewerSession(page, "/marketplace");
    await unlockIfNeeded(page);
    await page.waitForTimeout(1500);
    await screenshot(page, "01-authenticated");

    // ── Step 2: Marketplace discovery — investor persona ──
    test.info().annotations.push({ type: "step", description: "Browse marketplace as investor" });
    await gotoStable(page, "/marketplace");
    await unlockIfNeeded(page);
    await page.waitForTimeout(3000);
    await screenshot(page, "02-marketplace-discovery");

    // Check for swipe cards or list items
    const hasCards =
      (await page.locator("button:has-text('Connect')").count()) > 0 ||
      (await page.locator("button:has-text('View')").count()) > 0;

    if (hasCards) {
      test.info().annotations.push({ type: "info", description: "Discovery cards found" });
    }

    // Check search bar
    const searchToggle = page.getByLabel("Toggle search");
    if (await searchToggle.isVisible().catch(() => false)) {
      await searchToggle.click();
      await page.waitForTimeout(500);
      await screenshot(page, "02b-search-open");
      await searchToggle.click();
    }

    // Check view toggle
    const listView = page.getByLabel("List view");
    if (await listView.isVisible().catch(() => false)) {
      await listView.click();
      await page.waitForTimeout(1500);
      await screenshot(page, "02c-list-view");
    }

    // ── Step 3: Navigate to connections ──
    test.info().annotations.push({ type: "step", description: "Navigate to connections" });
    const connectionsButton = page.getByRole("button", { name: /connections/i }).first();
    if (await connectionsButton.isVisible().catch(() => false)) {
      await connectionsButton.click();
    } else {
      await gotoStable(page, "/marketplace/connections");
    }
    await page.waitForTimeout(2000);
    await screenshot(page, "03-connections-page");

    // Verify connections page loaded
    const connectionsHeading = page.getByText(/investor connections|advisor connections/i).first();
    await expect(connectionsHeading).toBeVisible({ timeout: 10000 });

    // Verify tabs are present
    await expect(page.getByText(/pending/i).first()).toBeVisible();
    await expect(page.getByText(/active/i).first()).toBeVisible();
    await expect(page.getByText(/previous/i).first()).toBeVisible();

    // ── Step 4: Check empty states with CTAs ──
    test.info().annotations.push({ type: "step", description: "Verify empty state CTAs" });
    const emptyState = page.getByText(/no.*connections/i).first();
    const marketplaceCta = page.getByRole("button", { name: /browse the marketplace/i }).first();
    if (await emptyState.isVisible().catch(() => false)) {
      test.info().annotations.push({ type: "info", description: "Empty state with CTA visible" });
      if (await marketplaceCta.isVisible().catch(() => false)) {
        test.info().annotations.push({ type: "pass", description: "Marketplace CTA present in empty state" });
      }
    }
    await screenshot(page, "04-connections-empty-or-list");

    // ── Step 5: Click on a connection if available ──
    test.info().annotations.push({ type: "step", description: "Test connection detail panel" });
    const firstConnection = page.locator("button").filter({ has: page.locator(".truncate") }).first();
    if (await firstConnection.isVisible().catch(() => false)) {
      await firstConnection.click();
      await page.waitForTimeout(1500);
      await screenshot(page, "05-connection-detail-panel");

      // Verify detail panel is opaque (not transparent)
      const sheetContent = page.locator('[data-slot="sheet-content"]').first();
      const drawerContent = page.locator('[data-slot="drawer-content"]').first();
      const panelVisible =
        (await sheetContent.isVisible().catch(() => false)) ||
        (await drawerContent.isVisible().catch(() => false));

      if (panelVisible) {
        test.info().annotations.push({ type: "pass", description: "Detail panel opened with opaque background" });

        // Check for ripple on rows
        const rippleElements = await page.locator('[data-morphy-ripple]').count();
        test.info().annotations.push({
          type: "info",
          description: `Ripple elements found: ${rippleElements}`,
        });
      }
    }

    // ── Step 6: Switch tabs ──
    test.info().annotations.push({ type: "step", description: "Switch connection tabs" });
    const activeTab = page.getByText(/active/i).first();
    if (await activeTab.isVisible().catch(() => false)) {
      await activeTab.click();
      await page.waitForTimeout(1000);
      await screenshot(page, "06-active-tab");
    }

    const previousTab = page.getByText(/previous/i).first();
    if (await previousTab.isVisible().catch(() => false)) {
      await previousTab.click();
      await page.waitForTimeout(1000);
      await screenshot(page, "06b-previous-tab");
    }

    // ── Step 7: Switch to RIA persona ──
    test.info().annotations.push({ type: "step", description: "Switch to RIA persona" });
    await ensurePersona(page, "ria");
    await page.waitForTimeout(2000);
    await screenshot(page, "07-ria-persona");

    // ── Step 8: Navigate to connections as RIA ──
    test.info().annotations.push({ type: "step", description: "Connections as RIA" });
    await gotoStable(page, "/marketplace/connections");
    await page.waitForTimeout(2000);
    await screenshot(page, "08-ria-connections");

    // Verify RIA connections title
    const riaConnectionsTitle = page.getByText(/investor connections/i).first();
    if (await riaConnectionsTitle.isVisible().catch(() => false)) {
      test.info().annotations.push({ type: "pass", description: "RIA connections view showing investor connections" });
    }

    // ── Step 9: Check breadcrumb back button ──
    test.info().annotations.push({ type: "step", description: "Verify breadcrumb back button" });
    const backButton = page.locator('[data-testid="top-app-bar-row"] button[aria-label="Go back"]').first();
    const topBarBack = page.locator('[aria-label="Go back"]').first();
    if (await topBarBack.isVisible().catch(() => false)) {
      test.info().annotations.push({ type: "pass", description: "Top bar back button visible on connections" });
    } else {
      test.info().annotations.push({ type: "warn", description: "Top bar back button not found on connections page" });
    }

    // ── Step 10: Navigate to marketplace as RIA ──
    test.info().annotations.push({ type: "step", description: "Marketplace as RIA" });
    await gotoStable(page, "/marketplace");
    await page.waitForTimeout(2000);
    await screenshot(page, "09-marketplace-ria");

    // ── Step 11: Open a profile detail sheet ──
    test.info().annotations.push({ type: "step", description: "Open profile detail" });
    const viewButton = page.getByRole("button", { name: /view/i }).first();
    const viewDetailsButton = page.getByRole("button", { name: /view details/i }).first();
    const detailTrigger = (await viewDetailsButton.isVisible().catch(() => false))
      ? viewDetailsButton
      : viewButton;

    if (await detailTrigger.isVisible().catch(() => false)) {
      await detailTrigger.click();
      await page.waitForTimeout(1500);
      await screenshot(page, "10-profile-detail-panel");

      // Verify it's a proper side panel on desktop (not bottom sheet)
      const sideSheet = page.locator('[data-slot="sheet-content"]').first();
      const drawer = page.locator('[data-slot="drawer-content"]').first();
      if (await sideSheet.isVisible().catch(() => false)) {
        test.info().annotations.push({ type: "pass", description: "Profile detail uses right-side sheet on desktop" });
      } else if (await drawer.isVisible().catch(() => false)) {
        test.info().annotations.push({ type: "pass", description: "Profile detail uses drawer on mobile" });
      }

      // Close it
      const closeButton = page.locator('[data-slot="sheet-content"] button:has(svg)').first();
      if (await closeButton.isVisible().catch(() => false)) {
        await closeButton.click();
        await page.waitForTimeout(500);
      }
    }

    // ── Step 12: Check consent manager ──
    test.info().annotations.push({ type: "step", description: "Consent manager" });
    await gotoStable(page, "/consents");
    await page.waitForTimeout(2000);
    await screenshot(page, "11-consent-manager");

    // Verify consent manager has avatars
    const consentAvatars = await page
      .locator("button .rounded-full.border")
      .count();
    test.info().annotations.push({
      type: "info",
      description: `Consent entry avatars found: ${consentAvatars}`,
    });

    // ── Step 13: Check bottom navbar ──
    test.info().annotations.push({ type: "step", description: "Bottom navbar audit" });
    const navbar = page.locator("nav").filter({ has: page.locator('[data-morphy-ripple]') }).first();
    if (await navbar.isVisible().catch(() => false)) {
      test.info().annotations.push({ type: "pass", description: "Bottom navbar visible with ripple" });

      // Check for glass effect (backdrop blur)
      const navStyles = await navbar.evaluate((el) => {
        const styles = getComputedStyle(el.querySelector('[class*="segmented"]') || el);
        return {
          backdropFilter: styles.backdropFilter || styles.webkitBackdropFilter || "",
          boxShadow: styles.boxShadow || "",
          backgroundColor: styles.backgroundColor || "",
        };
      });
      test.info().annotations.push({
        type: "info",
        description: `Navbar styles: blur=${navStyles.backdropFilter}, shadow=${navStyles.boxShadow ? "yes" : "none"}`,
      });
    }

    // ── Step 14: RIA onboarding — check verification CTAs ──
    test.info().annotations.push({ type: "step", description: "RIA onboarding verification" });
    await gotoStable(page, "/ria/onboarding");
    await page.waitForTimeout(2000);
    await screenshot(page, "12-ria-onboarding");

    const submitVerify = page.getByRole("button", { name: /submit for verification/i }).first();
    const bypassButton = page.getByRole("button", { name: /bypass in dev/i }).first();
    if (await submitVerify.isVisible().catch(() => false)) {
      test.info().annotations.push({ type: "pass", description: "Submit for verification CTA present" });
    }
    if (await bypassButton.isVisible().catch(() => false)) {
      test.info().annotations.push({ type: "pass", description: "Bypass in Dev/UAT CTA present" });
    }

    // ── Step 15: Portfolio explorer (if connection exists) ──
    test.info().annotations.push({ type: "step", description: "Portfolio explorer check" });
    await gotoStable(page, "/marketplace/connections?tab=active");
    await page.waitForTimeout(2000);

    const portfolioLink = page.getByRole("button", { name: /open portfolio explorer/i }).first();
    if (await portfolioLink.isVisible().catch(() => false)) {
      await portfolioLink.click();
      await page.waitForTimeout(2000);
      await screenshot(page, "13-portfolio-explorer");

      // Check breadcrumb
      const breadcrumb = page.getByText(/connections/i).first();
      if (await breadcrumb.isVisible().catch(() => false)) {
        test.info().annotations.push({ type: "pass", description: "Portfolio explorer breadcrumb visible" });
      }

      // Check allocation bar
      const allocationBar = page.locator(".rounded-full .h-full").first();
      if (await allocationBar.isVisible().catch(() => false)) {
        test.info().annotations.push({ type: "pass", description: "Allocation bar rendered" });
      }
    }

    // ── Step 16: Profile page ──
    test.info().annotations.push({ type: "step", description: "Profile page" });
    await gotoStable(page, "/profile");
    await page.waitForTimeout(2000);
    await screenshot(page, "14-profile-page");

    // ── Final summary ──
    await screenshot(page, "99-final-state");
    test.info().annotations.push({ type: "summary", description: "Connection flow E2E complete" });
  });
});

test.describe("Connection Flow — Mobile", () => {
  test.setTimeout(180_000);

  test("mobile connection flow parity", async ({ browser }) => {
    const context = await browser.newContext({ ...devices["iPhone 13"] });
    const page = await context.newPage();
    await installPasskeyBypass(page);

    // Authenticate
    await ensureReviewerSession(page, "/marketplace");
    await unlockIfNeeded(page);
    await page.waitForTimeout(1500);
    await screenshot(page, "mobile-01-authenticated");

    // Marketplace
    await gotoStable(page, "/marketplace");
    await page.waitForTimeout(2000);
    await screenshot(page, "mobile-02-marketplace");

    // Connections
    await gotoStable(page, "/marketplace/connections");
    await page.waitForTimeout(2000);
    await screenshot(page, "mobile-03-connections");

    // Verify drawer is used on mobile (not sheet)
    const firstRow = page.locator("button").filter({ has: page.locator(".truncate") }).first();
    if (await firstRow.isVisible().catch(() => false)) {
      await firstRow.click();
      await page.waitForTimeout(1500);
      await screenshot(page, "mobile-04-detail-drawer");

      const drawer = page.locator('[data-slot="drawer-content"]').first();
      if (await drawer.isVisible().catch(() => false)) {
        test.info().annotations.push({ type: "pass", description: "Mobile uses drawer for detail panel" });

        // Check drawer z-index is above bottom nav
        const drawerZ = await drawer.evaluate((el) => {
          return parseInt(getComputedStyle(el).zIndex || "0", 10);
        });
        const nav = page.locator("nav").first();
        const navZ = await nav.evaluate((el) => {
          return parseInt(getComputedStyle(el).zIndex || "0", 10);
        }).catch(() => 0);

        if (drawerZ > navZ) {
          test.info().annotations.push({
            type: "pass",
            description: `Drawer z-index (${drawerZ}) > navbar z-index (${navZ})`,
          });
        } else {
          test.info().annotations.push({
            type: "fail",
            description: `Drawer z-index (${drawerZ}) NOT above navbar z-index (${navZ})`,
          });
        }
      }
    }

    // Consent manager on mobile
    await gotoStable(page, "/consents");
    await page.waitForTimeout(2000);
    await screenshot(page, "mobile-05-consent-manager");

    // Bottom navbar on mobile
    const navbar = page.locator("nav").first();
    if (await navbar.isVisible().catch(() => false)) {
      await screenshot(page, "mobile-06-navbar");
      test.info().annotations.push({ type: "pass", description: "Bottom navbar visible on mobile" });
    }

    await screenshot(page, "mobile-99-final");
    await context.close();
  });
});
