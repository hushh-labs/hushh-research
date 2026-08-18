import { expect, test } from "@playwright/test";

/**
 * The welcome screen ("/") is a single-screen composition. It has exactly one
 * message and one primary action, and it must fit a phone without scrolling.
 *
 * This runs against the real route rather than a synthetic mount, because the
 * two things it guards — whether the page scrolls, and whether the fixed
 * "Talk to One" bar covers the footer — are both produced by the app shell,
 * not by this component's own stylesheet.
 *
 * Run with: npm run test:layout-contracts
 */

/** iPhone SE, iPhone 12/13/14, iPhone 14 Pro Max. iOS is where the users are. */
const PHONES = [
  { name: "iPhone SE", width: 375, height: 667 },
  { name: "iPhone 14", width: 390, height: 844 },
  { name: "iPhone 14 Pro Max", width: 430, height: 932 },
] as const;

/** Sub-pixel slack only. Not room for a hidden row. */
const SLACK_PX = 2;

async function gotoWelcome(page: import("@playwright/test").Page) {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "One" })).toBeVisible({
    timeout: 20_000,
  });
  // The entrance animations translate elements; measuring mid-flight reports
  // positions the user never sees.
  await page.waitForTimeout(1200);
}

for (const phone of PHONES) {
  test.describe(`welcome at ${phone.name} (${phone.width}x${phone.height})`, () => {
    test.use({ viewport: { width: phone.width, height: phone.height } });

    test("fits without vertical or horizontal scrolling", async ({ page }) => {
      await gotoWelcome(page);

      const overflow = await page.evaluate(() => {
        const de = document.documentElement;
        let worstY = 0;
        let worstX = 0;
        // The page scroll root is a nested element, not <html>, so check every
        // scrollable box — a nested scroller is exactly how the visible
        // scrollbar in the founder's screenshot got there.
        for (const el of Array.from(document.querySelectorAll<HTMLElement>("*"))) {
          const style = getComputedStyle(el);
          if (style.display === "none" || style.visibility === "hidden") continue;
          const canScrollY =
            style.overflowY === "auto" || style.overflowY === "scroll";
          const canScrollX =
            style.overflowX === "auto" || style.overflowX === "scroll";
          if (canScrollY) worstY = Math.max(worstY, el.scrollHeight - el.clientHeight);
          if (canScrollX) worstX = Math.max(worstX, el.scrollWidth - el.clientWidth);
        }
        return {
          y: Math.max(worstY, de.scrollHeight - de.clientHeight),
          x: Math.max(worstX, de.scrollWidth - de.clientWidth),
        };
      });

      expect(overflow.y).toBeLessThanOrEqual(SLACK_PX);
      expect(overflow.x).toBeLessThanOrEqual(SLACK_PX);
    });

    test("shows the whole screen inside the viewport, nothing clipped", async ({
      page,
    }) => {
      await gotoWelcome(page);

      const parts = {
        one: page.getByRole("heading", { name: "One" }),
        supporting: page.getByText("Your personal assistant for everyday tasks."),
        cta: page.getByRole("button", { name: /get started/i }),
        privacy: page.getByText("You control what you share."),
        research: page.getByRole("link", { name: "Research" }),
        blog: page.getByRole("link", { name: "Blog" }),
        developers: page.getByRole("link", { name: "Developers" }),
        talkToOne: page.getByText("Talk to One"),
      };

      for (const [name, locator] of Object.entries(parts)) {
        await expect(locator, `${name} is visible`).toBeVisible();
        const box = await locator.boundingBox();
        expect(box, `${name} has a box`).not.toBeNull();
        expect(box!.y, `${name} top is on screen`).toBeGreaterThanOrEqual(-SLACK_PX);
        expect(
          box!.y + box!.height,
          `${name} bottom is on screen`,
        ).toBeLessThanOrEqual(phone.height + SLACK_PX);
        expect(box!.x, `${name} left is on screen`).toBeGreaterThanOrEqual(-SLACK_PX);
        expect(
          box!.x + box!.width,
          `${name} right is on screen`,
        ).toBeLessThanOrEqual(phone.width + SLACK_PX);
      }
    });

    test("the bottom bar never covers the footer links or the button", async ({
      page,
    }) => {
      await gotoWelcome(page);

      const bar = await page.getByText("Talk to One").boundingBox();
      const developers = await page
        .getByRole("link", { name: "Developers" })
        .boundingBox();
      const cta = await page
        .getByRole("button", { name: /get started/i })
        .boundingBox();

      expect(bar).not.toBeNull();
      expect(developers).not.toBeNull();
      expect(cta).not.toBeNull();

      // Every footer element ends above where the bar begins.
      expect(developers!.y + developers!.height).toBeLessThanOrEqual(
        bar!.y + SLACK_PX,
      );
      expect(cta!.y + cta!.height).toBeLessThanOrEqual(bar!.y + SLACK_PX);
    });

    test("no label wraps or ellipsizes", async ({ page }) => {
      await gotoWelcome(page);

      const clipped = await page.evaluate(() => {
        const texts = [
          "Your personal assistant for everyday tasks.",
          "You control what you share.",
          "Get started",
          "Research",
          "Blog",
          "Developers",
        ];
        const bad: string[] = [];
        for (const el of Array.from(document.querySelectorAll<HTMLElement>("*"))) {
          const own = (el.textContent || "").trim();
          if (!texts.includes(own)) continue;
          if (el.scrollWidth > el.clientWidth + 1) bad.push(`${own}: horizontally clipped`);
          if (el.scrollHeight > el.clientHeight + 1) bad.push(`${own}: vertically clipped`);
        }
        return bad;
      });

      expect(clipped).toEqual([]);
    });
  });
}

test.describe("welcome primary action", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("Get started is a 56px full-width control that opens sign-in", async ({
    page,
  }) => {
    await gotoWelcome(page);

    const cta = page.getByRole("button", { name: /get started/i });
    const box = (await cta.boundingBox())!;

    // 56px tall, and full width inside the 24px screen padding.
    expect(box.height).toBeGreaterThanOrEqual(56 - SLACK_PX);
    expect(box.width).toBeGreaterThanOrEqual(390 - 48 - SLACK_PX);

    // The entire button is the target, not just its label.
    await page.mouse.click(box.x + 8, box.y + box.height - 8);
    await page.waitForURL(/\/login/, { timeout: 15_000 });
  });

  test("exactly one heading and one button on the screen", async ({ page }) => {
    await gotoWelcome(page);

    await expect(page.locator("main h1")).toHaveCount(1);
    await expect(page.locator("main button")).toHaveCount(1);
  });

  test("the removed marketing lines are gone", async ({ page }) => {
    await gotoWelcome(page);

    for (const gone of [
      "Your private agent",
      "Your agents. Yours to own.",
      "Everything you save stays locked.",
      "Nothing moves without your yes.",
      "🤫",
    ]) {
      await expect(page.getByText(gone, { exact: false })).toHaveCount(0);
    }
  });
});
