import { expect, test, type Page } from "@playwright/test";

const hasReviewerEnv = Boolean(
  process.env.REVIEWER_UID ||
    process.env.NEXT_PUBLIC_REVIEWER_UID ||
    process.env.HUSHH_UI_TEST_REVIEWER_UID,
);

const viewports = [
  { width: 390, height: 844 },
  { width: 430, height: 932 },
  { width: 768, height: 1024 },
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
    test(`keeps the Apple grouped-list contract at ${viewport.width}x${viewport.height}`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      await openOneDirectory(page);

      await expect(
        page.getByRole("heading", { name: "Agents (7)" }),
      ).toBeVisible();
      await expect(page.getByTestId("one-agents-search")).toBeVisible();
      await expect(page.getByTestId("one-agents-list")).toBeVisible();

      const metrics = await page.evaluate(() => {
        const foundation = document.querySelector(".foundation-public-ambient");
        const foundationStyle = foundation
          ? getComputedStyle(foundation)
          : null;
        const title = document
          .querySelector("#one-agents-heading span:first-child");
        const titleStyle = title ? getComputedStyle(title) : null;
        const search = document.querySelector(
          '[data-testid="one-agents-search"]',
        );
        const searchStyle = search ? getComputedStyle(search) : null;
        const list = document.querySelector('[data-testid="one-agents-list"]');
        const listStyle = list ? getComputedStyle(list) : null;
        const rows = Array.from(
          document.querySelectorAll('[data-testid^="one-agent-list-row-"]'),
        );
        const metricRightEdges = rows.map((row) => {
          const metric = row.querySelector('[data-ui-role="body-strong"]')
            ?.parentElement;
          return Math.round(metric?.getBoundingClientRect().right ?? 0);
        });
        const rowHeights = rows.map((row) =>
          Math.round(row.getBoundingClientRect().height),
        );
        return {
          foundationBackgroundImage: foundationStyle?.backgroundImage,
          foundationBackgroundColor: foundationStyle?.backgroundColor,
          titleFontSize: titleStyle?.fontSize,
          titleFontWeight: titleStyle?.fontWeight,
          titleLineHeight: titleStyle?.lineHeight,
          searchHeight: Math.round(search?.getBoundingClientRect().height ?? 0),
          searchRadius: searchStyle?.borderRadius,
          listRadius: listStyle?.borderRadius,
          rowCount: rows.length,
          rowHeights,
          metricRightEdges,
        };
      });

      expect(metrics.foundationBackgroundImage).toBe("none");
      expect(metrics.titleFontSize).toBe("34px");
      expect(metrics.titleFontWeight).toBe("700");
      expect(metrics.titleLineHeight).toBe("41px");
      expect(metrics.searchHeight).toBe(52);
      expect(metrics.searchRadius).toBe("16px");
      expect(metrics.listRadius).toBe("22px");
      expect(metrics.rowCount).toBe(7);
      expect(metrics.rowHeights.every((height) => height >= 64)).toBe(true);
      expect(new Set(metrics.metricRightEdges).size).toBe(1);
    });
  }
});
