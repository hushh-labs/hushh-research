import { expect, test, type Locator, type Page } from "@playwright/test";

async function answerPersona(page: Page) {
  await page.getByRole("button", { name: "Continue", exact: true }).click();
}

// A paused CSS animation freezes on the next style recalculation. Two matching
// reads avoid mistaking the transition frame for the paused state.
async function frozenTransform(locator: Locator): Promise<string> {
  let previous = "";
  await expect
    .poll(
      async () => {
        const current = await locator.evaluate(
          (el) => getComputedStyle(el).transform,
        );
        const settled = current === previous;
        previous = current;
        return settled;
      },
      { intervals: [100], timeout: 5000 },
    )
    .toBe(true);
  return previous;
}

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
          // Waits only time the evidence screenshots. Animated values are polled,
          // because WebKit screenshots and a loaded runner shift when a single
          // read lands inside the timeline.
          await page.waitForTimeout(1800);
          await page.screenshot({
            path: testInfo.outputPath("market-motion.png"),
          });
          const path = phone.locator('[data-scene="0"] path').first();
          await expect
            .poll(() =>
              path.evaluate((el) => getComputedStyle(el).strokeDashoffset),
            )
            .toBe("0px");
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
          const agentOpacity = () =>
            agents
              .first()
              .evaluate((el) => Number(getComputedStyle(el).opacity));
          await expect.poll(agentOpacity).toBe(1);
          await page.waitForTimeout(4300);
          await page.screenshot({
            path: testInfo.outputPath("stocks-consensus.png"),
          });
          await expect
            .poll(() =>
              phone
                .locator('[class*="decision"]')
                .first()
                .evaluate((el) => Number(getComputedStyle(el).opacity)),
            )
            .toBe(1);
          // The Stocks scene lasts 11.8s; screenshot time is not part of it.
          await expect(phone).toHaveAttribute("data-demo-slide", "0", {
            timeout: 12000,
          });
          // Scene DOM survives the entire loop; restarting does not flash/unmount it.
          await expect(scenes).toHaveCount(3);
          await page
            .getByRole("button", { name: "Pause Finance introduction" })
            .click();
          const progress = page.locator('[data-demo-progress="true"]');
          await expect(demo).toHaveAttribute("data-playing", "false");
          const before = await frozenTransform(progress);
          await page.waitForTimeout(500);
          expect(
            await progress.evaluate((el) => getComputedStyle(el).transform),
          ).toBe(before);
          await page
            .getByRole("button", { name: "Show Stocks introduction" })
            .click();
          await expect(phone).toHaveAttribute("data-demo-slide", "2");
          await expect.poll(agentOpacity).toBe(1);
          await expect(demo).toHaveAttribute("data-playing", "false");
          await page
            .getByRole("button", { name: "Play Finance introduction" })
            .click();
          await expect
            .poll(() =>
              progress.evaluate((el) => getComputedStyle(el).transform),
            )
            .not.toBe(before);
          await page.evaluate(() => {
            Object.defineProperty(document, "hidden", {
              configurable: true,
              value: true,
            });
            document.dispatchEvent(new Event("visibilitychange"));
          });
          await expect(demo).toHaveAttribute("data-playing", "false");
          const hiddenFrame = await frozenTransform(progress);
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
          await answerPersona(page);
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
        await page.getByRole("button", { name: "Show Stocks introduction" }).click();
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
        await answerPersona(page);
        const bank = page.getByRole("button", { name: /Connect an account/ });
        const statement = page.getByRole("button", {
          name: /Upload a statement/,
        });
        const sample = page.getByRole("button", { name: /Try a sample/ });
        const a = (await bank.boundingBox())!;
        const b = (await statement.boundingBox())!;
        const c = (await sample.boundingBox())!;
        expect(a.y + a.height).toBeLessThan(b.y);
        expect(b.y + b.height).toBeLessThan(c.y);
        expect(Math.abs(a.width - b.width)).toBeLessThanOrEqual(1);
        expect(Math.abs(b.width - c.width)).toBeLessThanOrEqual(1);
        await expect(page.getByText("Recommended")).toHaveCount(0);
        await expect(page.getByRole("button", { name: "Connect account", exact: true })).toHaveCount(0);
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
    await answerPersona(page);
    await page
      .getByRole("button", { name: "Skip for now", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Open Finance" }),
    ).toBeVisible();
  });

  for (const width of [390, 960]) {
    test(`Finance persona questions and reveal at ${width}px`, async ({
      page,
    }, testInfo) => {
      await page.emulateMedia({
        reducedMotion: width === 390 ? "reduce" : "no-preference",
      });
      await mount(page, width);
      await page.getByRole("button", { name: "Continue", exact: true }).click();
      await expect(
        page.getByRole("heading", {
          name: "Let’s build your financial persona",
        }),
      ).toBeVisible();
      const groups = page
        .getByRole("group")
        .filter({ has: page.getByRole("radio") });
      await expect(groups).toHaveCount(3);
      await expect
        .poll(() =>
          groups
            .first()
            .evaluate(
              (field) =>
                field.closest("[data-direction]")?.querySelector("[inert]")
                  ?.childElementCount,
            ),
        )
        .toBe(0);
      const first = (await groups.nth(0).boundingBox())!;
      const second = (await groups.nth(1).boundingBox())!;
      expect(second.y).toBeGreaterThan(first.y + first.height);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(width);
      await page.screenshot({
        path: testInfo.outputPath("persona-questions.png"),
        fullPage: true,
      });
      await page.getByRole("radio", { name: "Less than 3 years" }).check();
      await page
        .getByRole("radio", {
          name: "Consider investing more if my plan still fits",
        })
        .check();
      await page.getByRole("radio", { name: "Lose 30% or gain 35%" }).check();
      await page
        .getByRole("radio", {
          name: "I’d probably need to sell to cover bills",
        })
        .check();
      await page.getByRole("button", { name: "Save persona" }).click();
      await expect(
        page.getByRole("button", { name: /Connect an account/ }),
      ).toBeVisible();
    });
  }

  test("Finance approved onboarding dispatches the selected source once and blocks busy navigation", async ({
    page,
  }) => {
    await mount(page, 393);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await answerPersona(page);
    await page.getByRole("button", { name: /Try a sample/ }).click();
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
