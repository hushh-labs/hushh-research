import { expect, test, type Page } from "@playwright/test";

const hasReviewerEnv = Boolean(
  process.env.REVIEWER_UID ||
    process.env.NEXT_PUBLIC_REVIEWER_UID ||
    process.env.HUSHH_UI_TEST_REVIEWER_UID,
);

const viewports = [
  { width: 320, height: 568 },
  { width: 375, height: 667 },
  { width: 390, height: 844 },
  { width: 430, height: 932 },
  { width: 768, height: 1024 },
  { width: 1024, height: 768 },
  { width: 1440, height: 900 },
] as const;

async function openOneDirectory(page: Page) {
  await page.goto(`/login?redirect=${encodeURIComponent("/one")}`, {
    waitUntil: "domcontentloaded",
  });

  const reviewerButton = page.getByRole("button", {
    name: /continue as reviewer/i,
  });
  if (await reviewerButton.isVisible().catch(() => false)) {
    await reviewerButton.click();
  }

  await page.waitForURL((url) => url.pathname === "/one", {
    timeout: 60_000,
  });
  await expect(page.getByTestId("one-agents-section")).toBeVisible({
    timeout: 30_000,
  });
}

test.describe("first post-login Agent Directory visual contract", () => {
  test.skip(
    !hasReviewerEnv,
    "requires reviewer auth env to verify the protected post-login route",
  );

  for (const viewport of viewports) {
    test(`keeps the premium app-icon launcher contract at ${viewport.width}x${viewport.height}`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      await openOneDirectory(page);

      await expect(page.getByTestId("one-agents-grid")).toBeVisible();
      await expect(page.getByTestId("one-agents-search")).toHaveCount(0);

      const metrics = await page.evaluate(() => {
        const foundation = document.querySelector(".foundation-public-ambient");
        const foundationStyle = foundation
          ? getComputedStyle(foundation)
          : null;
        const section = document.querySelector(
          '[data-testid="one-agents-section"]',
        );
        const sectionRect = section?.getBoundingClientRect();
        const grid = document.querySelector('[data-testid="one-agents-grid"]');
        const layout = document.querySelector(
          '[data-agent-roster-layout="app-icon-launcher-grid"]',
        );
        const tileElements = Array.from(
          document.querySelectorAll('[data-testid^="one-agent-tile-"]'),
        );
        const iconElements = Array.from(
          document.querySelectorAll('[data-testid^="one-agent-icon-"]'),
        );
        const tiles = tileElements.map((tile) => {
          const rect = tile.getBoundingClientRect();
          return {
            id: tile.getAttribute("data-testid"),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          };
        });
        const icons = iconElements.map((icon) => {
          const rect = icon.getBoundingClientRect();
          const style = getComputedStyle(icon);
          return {
            id: icon.getAttribute("data-testid"),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            radius: style.borderRadius,
          };
        });
        const horizontalOverflow =
          document.documentElement.scrollWidth > window.innerWidth + 1;
        const gridRect = grid?.getBoundingClientRect();
        const badges = Array.from(
          document.querySelectorAll(
            '[data-testid="one-agent-notification-badge"], [data-testid="one-agent-live-dot"]',
          ),
        ).map((badge) => {
          const rect = badge.getBoundingClientRect();
          return {
            left: Math.floor(rect.left),
            right: Math.ceil(rect.right),
            top: Math.floor(rect.top),
            bottom: Math.ceil(rect.bottom),
          };
        });
        return {
          foundationBackgroundImage: foundationStyle?.backgroundImage,
          foundationBackgroundColor: foundationStyle?.backgroundColor,
          sectionWidth: Math.round(sectionRect?.width ?? 0),
          gridClassName: layout?.className,
          gridWidth: Math.round(gridRect?.width ?? 0),
          tileCount: tiles.length,
          tiles,
          icons,
          horizontalOverflow,
          badges,
        };
      });

      expect(metrics.foundationBackgroundImage).toBe("none");
      expect(metrics.sectionWidth).toBeLessThanOrEqual(820);
      expect(metrics.gridClassName).toContain("grid-cols-3");
      expect(metrics.gridWidth).toBeLessThanOrEqual(640);
      expect(metrics.tileCount).toBe(9);
      expect(metrics.tiles.every((tile) => tile.height >= 100)).toBe(true);
      expect(metrics.icons.every((icon) => icon.width >= 60)).toBe(true);
      expect(metrics.icons.every((icon) => icon.height >= 60)).toBe(true);
      expect(
        metrics.icons.every((icon) =>
          ["19px", "18px", "17px", "16px", "14px"].includes(icon.radius),
        ),
      ).toBe(true);
      expect(metrics.horizontalOverflow).toBe(false);
      for (const badge of metrics.badges) {
        expect(badge.left).toBeGreaterThanOrEqual(0);
        expect(badge.right).toBeLessThanOrEqual(viewport.width);
        expect(badge.top).toBeGreaterThanOrEqual(0);
      }
    });
  }
});
