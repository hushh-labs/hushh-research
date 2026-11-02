import { expect, test, type Page } from "@playwright/test";

export function registerFinanceOnboardingChecks(
  mount: (page: Page, width: number) => Promise<void>,
) {
  test.describe("Finance onboarding motion parity", () => {
    for (const width of [390, 960]) {
      test(`Finance onboarding motion cycle and playback at ${width}px`, async ({
        browser,
      }, testInfo) => {
        test.setTimeout(65000);
        const page = await browser.newPage({
          recordVideo: {
            dir: testInfo.outputPath("recording"),
            size: { width, height: width === 390 ? 844 : 720 },
          },
        });
        try {
          await page.emulateMedia({ reducedMotion: "no-preference" });
          await mount(page, width);
          await page.setViewportSize({
            width,
            height: width === 390 ? 844 : 720,
          });
          const demo = page.getByRole("region", { name: "Meet Finance" });
          const phone = page.locator("[data-demo-slide]");
          const scenes = phone.locator("[data-scene]");
          await expect(demo).toHaveAttribute("data-playing", "true");
          await expect(scenes).toHaveCount(3);
          // A pointer interaction must not silently stop the timeline.
          await page
            .getByRole("heading", { name: "Follow the market." })
            .click();
          await expect(demo).toHaveAttribute("data-playing", "true");
          await page.waitForTimeout(1800);
          await page.screenshot({
            path: testInfo.outputPath("market-motion.png"),
          });
          const path = phone.locator('[data-scene="0"] path').first();
          expect(
            await path.evaluate((el) => getComputedStyle(el).strokeDashoffset),
          ).toBe("0px");
          await expect(phone).toHaveAttribute("data-demo-slide", "1", {
            timeout: 6500,
          });
          await page.waitForTimeout(2400);
          await page.screenshot({
            path: testInfo.outputPath("portfolio-motion.png"),
          });
          await expect(phone).toHaveAttribute("data-demo-slide", "2", {
            timeout: 6500,
          });
          await page.waitForTimeout(1000);
          await page.screenshot({
            path: testInfo.outputPath("stocks-selection.png"),
          });
          await page.waitForTimeout(4500);
          await page.screenshot({
            path: testInfo.outputPath("stocks-debate.png"),
          });
          const agents = phone.locator('[class*="agentCard"]');
          expect(
            await agents
              .first()
              .evaluate((el) => Number(getComputedStyle(el).opacity)),
          ).toBe(1);
          await page.waitForTimeout(4300);
          await page.screenshot({
            path: testInfo.outputPath("stocks-consensus.png"),
          });
          expect(
            await phone
              .locator('[class*="decision"]')
              .first()
              .evaluate((el) => Number(getComputedStyle(el).opacity)),
          ).toBe(1);
          await expect(phone).toHaveAttribute("data-demo-slide", "0", {
            timeout: 4500,
          });
          // Scene DOM survives the entire loop; restarting does not flash/unmount it.
          await expect(scenes).toHaveCount(3);
          await page
            .getByRole("button", { name: "Pause Finance introduction" })
            .click();
          const progress = page.locator('[data-demo-progress="true"]');
          const before = await progress.evaluate(
            (el) => getComputedStyle(el).transform,
          );
          await page.waitForTimeout(500);
          expect(
            await progress.evaluate((el) => getComputedStyle(el).transform),
          ).toBe(before);
          await page
            .getByRole("button", { name: "Show Stocks introduction" })
            .click();
          await expect(phone).toHaveAttribute("data-demo-slide", "2");
          expect(
            await agents
              .first()
              .evaluate((el) => Number(getComputedStyle(el).opacity)),
          ).toBe(1);
          await expect(demo).toHaveAttribute("data-playing", "false");
          await page
            .getByRole("button", { name: "Play Finance introduction" })
            .click();
          await page.waitForTimeout(300);
          expect(
            await progress.evaluate((el) => getComputedStyle(el).transform),
          ).not.toBe(before);
          await page.evaluate(() => {
            Object.defineProperty(document, "hidden", {
              configurable: true,
              value: true,
            });
            document.dispatchEvent(new Event("visibilitychange"));
          });
          await expect(demo).toHaveAttribute("data-playing", "false");
          const hiddenFrame = await progress.evaluate(
            (el) => getComputedStyle(el).transform,
          );
          await page.waitForTimeout(300);
          expect(
            await progress.evaluate((el) => getComputedStyle(el).transform),
          ).toBe(hiddenFrame);
          await page.evaluate(() => {
            Reflect.deleteProperty(document, "hidden");
            document.dispatchEvent(new Event("visibilitychange"));
          });
          await expect(demo).toHaveAttribute("data-playing", "true");
          await page
            .getByRole("button", { name: "Show Stocks introduction" })
            .click();
          await expect(demo).toHaveAttribute("data-playing", "true");
          await page
            .getByRole("button", { name: "Continue", exact: true })
            .click();
          await expect(
            page.getByRole("button", { name: /Connect an account/ }),
          ).toBeVisible();
          await page.waitForTimeout(800);
          await page.screenshot({
            path: testInfo.outputPath("import-motion.png"),
          });
          expect(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth,
            ),
          ).toBe(true);
          await page
            .getByRole("button", { name: "Skip for now", exact: true })
            .click();
          await expect(
            page.getByRole("heading", { name: "You're all set" }),
          ).toBeVisible();
          await page.waitForTimeout(600);
          await page.screenshot({
            path: testInfo.outputPath("completion-motion.png"),
          });
        } finally {
          await page.close();
        }
      });
    }
  });
  for (const width of [320, 393, 1440])
    for (const theme of ["light", "dark"]) {
      test(`Finance approved onboarding at ${width}px in ${theme}`, async ({
        page,
      }, testInfo) => {
        await page.emulateMedia({ reducedMotion: "reduce" });
        await mount(page, width);
        await page.evaluate(
          (value) =>
            document.documentElement.classList.toggle("dark", value === "dark"),
          theme,
        );
        const title = page.getByRole("heading", { name: "Follow the market." });
        await expect(title).toBeVisible();
        const typography = await title.evaluate((el) => {
          const s = getComputedStyle(el);
          return [s.fontFamily, s.fontSize, s.lineHeight, s.fontWeight];
        });
        expect(typography[0]).toContain("Plus Jakarta Sans");
        expect(typography.slice(1)).toEqual(["28px", "36px", "600"]);
        const phone = page.locator("[data-demo-slide]");
        const text = await title.boundingBox();
        const art = await phone.boundingBox();
        if (width >= 768) expect(art!.x).toBeGreaterThan(text!.x + text!.width);
        else expect(art!.y).toBeGreaterThan(text!.y + text!.height);
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        const introductionPath = testInfo.outputPath(
          "finance-introduction.png",
        );
        await page.screenshot({ path: introductionPath, fullPage: true });
        await testInfo.attach("Finance introduction", {
          path: introductionPath,
          contentType: "image/png",
        });
        // The actual swipe handler advances locally; it never completes setup.
        const x = art!.x + art!.width - 12;
        const y = art!.y + 80;
        await page.mouse.move(x, y);
        await page.mouse.down();
        await page.mouse.move(x - 100, y, { steps: 8 });
        await page.mouse.up();
        await expect(
          page.getByRole("heading", { name: "Know what you own." }),
        ).toBeVisible();
        await page.getByRole("button", { name: "Next", exact: true }).click();
        await expect(
          page.getByRole("heading", { name: "Let three agents debate." }),
        ).toBeVisible();
        expect(
          await phone
            .locator("path")
            .first()
            .evaluate((el) => getComputedStyle(el).animationName),
        ).toBe("none");
        await page
          .getByRole("button", { name: "Continue", exact: true })
          .click();
        const bank = page.getByRole("button", { name: /Connect an account/ });
        const statement = page.getByRole("button", {
          name: /Upload a statement/,
        });
        const sample = page.getByRole("button", { name: /Try a sample/ });
        const a = (await bank.boundingBox())!;
        const b = (await statement.boundingBox())!;
        const c = (await sample.boundingBox())!;
        if (width >= 768) {
          expect(a.x + a.width).toBeLessThan(b.x);
          expect(c.x).toBe(b.x);
          const connect = (await page
            .getByRole("button", { name: "Connect account", exact: true })
            .boundingBox())!;
          const skip = (await page
            .getByRole("button", { name: "Skip for now", exact: true })
            .boundingBox())!;
          const center = (a.x + b.x + b.width) / 2;
          expect(
            Math.abs(connect.x + connect.width / 2 - center),
          ).toBeLessThanOrEqual(1);
          expect(
            Math.abs(skip.x + skip.width / 2 - center),
          ).toBeLessThanOrEqual(1);
        } else {
          expect(a.y + a.height).toBeLessThan(b.y);
          expect(c.y).toBe(b.y);
        }
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        const pickerPath = testInfo.outputPath("finance-source-picker.png");
        await page.screenshot({ path: pickerPath, fullPage: true });
        await testInfo.attach("Finance source picker", {
          path: pickerPath,
          contentType: "image/png",
        });
        await sample.click();
        expect(
          await page.evaluate(() => document.body.dataset.sourceAction),
        ).toBeUndefined();
        await page
          .getByRole("button", { name: "Skip for now", exact: true })
          .click();
        await expect(
          page.getByRole("heading", { name: "You're all set" }),
        ).toBeVisible();
        const completionPath = testInfo.outputPath("finance-completion.png");
        await page.screenshot({ path: completionPath, fullPage: true });
        await testInfo.attach("Finance completion", {
          path: completionPath,
          contentType: "image/png",
        });
        expect(
          await page.evaluate(() => document.body.dataset.finished),
        ).toBeUndefined();
        await page
          .getByRole("button", { name: "Open Finance", exact: true })
          .click();
        expect(await page.evaluate(() => document.body.dataset.finished)).toBe(
          "true",
        );
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
      });
    }

  test("Finance approved onboarding keeps short-phone artwork and actions reachable", async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await mount(page, 393);
    await page.setViewportSize({ width: 393, height: 640 });
    await page
      .getByRole("button", { name: "Show Stocks introduction" })
      .click();
    const phone = page.locator("[data-demo-slide]");
    const consensus = phone.locator("strong").filter({ hasText: /Decision$/ });
    const clearance = await consensus.evaluate((el) => {
      const card = el.parentElement!.getBoundingClientRect();
      const phone = el.closest("[data-demo-slide]")!;
      const dock = phone
        .querySelector('[class*="phoneDock"]')!
        .getBoundingClientRect();
      return dock.top - card.bottom;
    });
    expect(clearance).toBeGreaterThanOrEqual(4);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page
      .getByRole("button", { name: "Skip for now", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Open Finance" }),
    ).toBeVisible();
  });

  test("Finance approved onboarding dispatches the selected source once and blocks busy navigation", async ({
    page,
  }) => {
    await mount(page, 393);
    await page.getByRole("button", { name: "Skip", exact: true }).click();
    await page.getByRole("button", { name: /Try a sample/ }).click();
    await page
      .getByRole("button", { name: "Load sample", exact: true })
      .click();
    expect(await page.evaluate(() => document.body.dataset.sourceAction)).toBe(
      "sample",
    );
    await expect(
      page.getByRole("button", { name: "Skip for now", exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Back to Finance introduction" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: /Connect an account/ }),
    ).toBeDisabled();
    await expect(
      page.getByRole("heading", { name: "You're all set" }),
    ).toHaveCount(0);
  });
}
