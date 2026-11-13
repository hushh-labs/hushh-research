import { expect, test, type Page } from "@playwright/test";

export function registerAdvisorReviewChecks(
  mount: (page: Page, width: number) => Promise<void>,
) {
  for (const width of [393, 1440]) {
    test(`Advisor recommendations require opt-in and preserve introduction approval at ${width}px`, async ({
      page,
    }) => {
      await mount(page, width);
      expect(
        await page.evaluate(
          () => document.body.dataset.recommendationProfileReads,
        ),
      ).toBeUndefined();
      await page
        .getByRole("button", { name: "Recommend advisor", exact: true })
        .click();
      const dialog = page.getByRole("dialog");
      await expect(
        dialog.getByText("What do you need help with?"),
      ).toBeVisible();
      await expect(dialog.getByText(/not sure/i)).toHaveCount(0);
      for (const label of [
        "Managing my investments",
        "Planning for retirement",
        "Planning around taxes",
        "Estate planning",
      ])
        await expect(
          dialog.getByRole("button", { name: label, exact: true }),
        ).toBeVisible();
      await dialog
        .getByRole("button", { name: "Managing my investments" })
        .click();
      await expect(dialog.getByText("Sample matching advisor 1")).toBeVisible();
      expect(
        await page.evaluate(() =>
          JSON.parse(document.body.dataset.advisorRecommendationBody || "{}"),
        ),
      ).toEqual({ scope: "recommended", service: "portfolio_management" });
      expect(
        await page.evaluate(() => document.body.dataset.portfolioReviewCalls),
      ).toBeUndefined();
      expect(
        await dialog.evaluate(
          (element) => element.scrollWidth <= element.clientWidth,
        ),
      ).toBe(true);
      await dialog
        .getByRole("button", { name: "Review introduction" })
        .first()
        .click();
      await expect(
        page
          .getByRole("dialog")
          .getByRole("heading", { name: "Finance snapshot" }),
      ).toBeVisible();
      await expect(
        page
          .getByRole("dialog")
          .getByRole("button", { name: "Send request", exact: true }),
      ).toBeDisabled();
      expect(
        await page.evaluate(() => document.body.dataset.advisorSends),
      ).toBeUndefined();
      await page
        .getByRole("dialog")
        .getByRole("button", { name: /^Close(?: detail panel)?$/ })
        .click();
      await page
        .getByRole("button", { name: "Recommend advisor", exact: true })
        .click();
      await expect(
        page.getByRole("dialog").getByText("Sample matching advisor 1"),
      ).toBeVisible();
      await expect(page.getByText("What do you need help with?")).toHaveCount(
        0,
      );
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "Change choice" })
        .click();
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "Planning around taxes" })
        .click();
      await expect(
        page.getByRole("dialog").getByText("Sample matching advisor 3"),
      ).toBeVisible();
      await expect(
        page.getByRole("dialog").getByText("Sample matching advisor 1"),
      ).toHaveCount(0);
    });
  }

  test("Finance advisor discovery separates connections, nearby and global search", async ({
    page,
  }) => {
    await mount(page, 393);
    await page
      .getByRole("button", { name: "Start sample advisor request" })
      .click();
    const dialog = page.getByRole("dialog");
    await expect(
      dialog.getByText("Sample advisor", { exact: true }),
    ).toBeVisible();
    await expect(page.locator("body")).toHaveAttribute(
      "data-advisor-candidate-scope",
      "connections",
    );
    await dialog.getByRole("tab", { name: "Nearby" }).click();
    await dialog.getByRole("textbox", { name: "Postal code" }).fill("10001");
    await dialog.getByRole("button", { name: "Search nearby" }).click();
    await expect(
      dialog.getByText("Local advisor", { exact: true }),
    ).toBeVisible();
    await dialog.getByRole("textbox", { name: "Advisor name" }).fill("Distant");
    await dialog.getByRole("button", { name: "Search", exact: true }).click();
    await expect(
      dialog.getByText("Distant advisor", { exact: true }),
    ).toBeVisible();
    await expect(page.locator("body")).toHaveAttribute(
      "data-advisor-candidate-scope",
      "global",
    );
    await expect(
      dialog.getByRole("textbox", { name: "Postal code" }),
    ).toHaveCount(0);
    await dialog.getByRole("button", { name: "Choose", exact: true }).click();
    await expect(
      dialog.getByRole("button", { name: "Send request" }),
    ).toBeDisabled();
  });

  test("Finance advisor request can be cancelled by its sender", async ({ page }) => {
    await mount(page, 393);
    await page.getByRole("button", { name: "Open sample outgoing request" }).click();
    const review = page.getByRole("dialog", { name: /Advisor review/ });
    const cancelRequest = review.getByRole("button", { name: "Cancel request" });
    await cancelRequest.click();
    const confirm = page.getByRole("alertdialog", { name: "Cancel advisor request?" });
    await confirm.getByRole("button", { name: "Keep request" }).click();
    await expect(review.getByText("Waiting for the advisor")).toBeVisible();
    await cancelRequest.click();
    await confirm.getByRole("button", { name: "Cancel request" }).click();
    await expect(review.getByRole("heading", { name: "Request cancelled" })).toBeVisible();
  });

  test("Finance advisor review lets the client end snapshot access", async ({ page }, info) => {
    await mount(page, 960);
    await page.evaluate(() => { document.body.dataset.advisorStage = "accepted"; });
    await page.getByRole("button", { name: "Open sample outgoing request" }).click();
    const review = page.getByRole("dialog", { name: /Advisor review/ });
    await expect(review.getByRole("button", { name: "Choose date" })).toBeVisible();
    const pager = review.locator('[data-swipe-views-root="true"]');
    const frame = await review.evaluateHandle(async (el) => {
      await Promise.all(el.getAnimations().map((animation) => animation.finished.catch(() => undefined)));
      const initial = el.getBoundingClientRect();
      let shift = 0;
      let frameId = 0;
      const sample = () => {
        const next = el.getBoundingClientRect();
        shift = Math.max(shift, Math.abs(next.height - initial.height), Math.abs(next.top - initial.top));
        frameId = requestAnimationFrame(sample);
      };
      frameId = requestAnimationFrame(sample);
      return { stop: () => { cancelAnimationFrame(frameId); return shift; } };
    });
    const swipe = async (forward: boolean) => {
      const box = (await pager.boundingBox())!;
      const y = box.y + 12;
      await page.mouse.move(box.x + box.width * (forward ? 0.8 : 0.2), y);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * (forward ? 0.2 : 0.8), y, { steps: 15 });
      await page.mouse.up();
    };
    await swipe(true);
    await expect(review.getByRole("tab", { name: "Portfolio" })).toHaveAttribute("aria-selected", "true");
    await expect(review.getByRole("heading", { name: "Finance snapshot" })).toBeVisible();
    await swipe(false);
    await expect(review.getByRole("tab", { name: "Meeting" })).toHaveAttribute("aria-selected", "true");
    await review.getByRole("tab", { name: "Plan", exact: true }).click();
    await expect(review.getByRole("tab", { name: "Plan", exact: true })).toHaveAttribute("aria-selected", "true");
    await review.getByRole("tab", { name: "Meeting" }).click();
    await expect(review.getByRole("tab", { name: "Meeting" })).toHaveAttribute("aria-selected", "true");
    expect(await frame.evaluate((trace) => trace.stop())).toBeLessThanOrEqual(1);
    await frame.dispose();
    await review.screenshot({ path: info.outputPath("advisor-client-review.png") });
    await review.getByRole("button", { name: "Cancel advisor review" }).click();
    const confirm = page.getByRole("alertdialog", { name: "Cancel advisor review?" });
    await confirm.getByRole("button", { name: "Cancel review", exact: true }).click();
    await expect(review.getByRole("heading", { name: "Portfolio sharing stopped" })).toBeVisible();
    await expect(review.getByRole("tab", { name: "Portfolio" })).toHaveCount(0);
  });

  for (const width of [393, 960]) {
    test(`Finance portfolio review is inline and refreshes saved changes with approval at ${width}px`, async ({
      page,
    }, info) => {
      await mount(page, width);
      const toggle = page.getByRole("button", { name: "Toggle sample analysis" });
      await toggle.click();
      const review = page.getByRole("region", { name: "Portfolio review", exact: true });
      const enable = review.getByRole("button", { name: "Allow portfolio review" });
      const calls = "data-portfolio-review-calls";
      await expect(review.getByRole("heading", { name: "Portfolio review" })).toBeVisible();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(page.locator("body")).not.toHaveAttribute(calls);
      const mix = review.getByRole("heading", { name: "Portfolio mix" });
      const scenario = review.getByRole("heading", { name: "What if your largest stock falls?" });
      await expect(scenario).toBeVisible();
      await expect(review.getByText("−5.8%")).toBeVisible();
      await review.getByRole("button", { name: "−30%" }).click();
      await expect(review.getByText("−8.7%")).toBeVisible();
      const mixBox = (await mix.boundingBox())!;
      const scenarioBox = (await scenario.boundingBox())!;
      if (width >= 768) {
        expect(Math.abs(scenarioBox.y - mixBox.y)).toBeLessThan(2);
        expect(scenarioBox.x).toBeGreaterThan(mixBox.x);
      } else {
        expect(scenarioBox.y).toBeGreaterThan(mixBox.y);
      }
      await enable.click();
      await expect(review.getByText("72 / 100")).toBeVisible();
      const persona = review.getByText("Growth-oriented", { exact: true });
      await expect(persona).toBeVisible();
      expect(await persona.evaluate((el) => getComputedStyle(el, "::before").backgroundColor)).toBe("rgb(164, 95, 115)");
      const advisor = page.getByRole("region", { name: "Talk to an advisor" });
      const requests = (await advisor.getByText(/^Advisor requests/).boundingBox())!;
      const find = (await advisor.getByRole("button", { name: "Find an advisor" }).boundingBox())!;
      expect(Math.abs(requests.y - find.y)).toBeLessThan(3);
      await page.getByRole("region", { name: "Human advisor review" }).screenshot({ path: info.outputPath("portfolio-review.png") });

      await review.getByRole("button", { name: "Refine persona" }).click();
      const dialog = page.getByRole("dialog", { name: "Refine persona" });
      const progress = dialog.getByRole("progressbar");
      const dashes = progress.locator("[data-tone]");
      await expect(dashes).toHaveCount(13);
      const colors = () => dashes.evaluateAll((steps) => steps.map((step) => getComputedStyle(step).backgroundColor));
      expect(await colors()).toEqual(Array(13).fill("rgb(220, 224, 232)"));
      await dialog.getByRole("radio", { name: "I can accept large swings over time" }).check();
      expect(await colors()).toEqual(["rgb(164, 95, 115)", ...Array(12).fill("rgb(220, 224, 232)")]);
      await dialog.screenshot({ path: info.outputPath("refine-persona.png") });

      const answers = dialog.getByRole("radio");
      const next = dialog.getByRole("button", { name: "Continue", exact: true });
      const answerColors: string[] = [];
      for (const answer of [0, 1, 2]) {
        await answers.nth(answer).check();
        answerColors.push((await colors())[0]!);
      }
      expect(new Set(answerColors).size).toBe(3);
      await next.click();
      for (let index = 1; index < 13; index++) {
        if (index >= 8) {
          for (const answer of [0, 1, 2]) {
            await answers.nth(answer).check();
            expect((await colors())[index]).toBe(answerColors[answer]);
          }
          await answers.nth(3).check();
          await expect(dashes.nth(index)).toHaveAttribute("data-tone", "unsure");
        } else {
          await answers.nth(2).check();
        }
        if (index < 12) await next.click();
      }
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);

      await toggle.click();
      await toggle.click();
      await expect(review.getByText("72 / 100")).toBeVisible();
      await expect(page.locator("body")).toHaveAttribute(calls, "1");
      await page.evaluate(() => { document.body.dataset.portfolioReviewFailed = "true"; });
      await page.getByRole("button", { name: "Update sample portfolio" }).click();
      await expect(review.getByText("The private agent couldn’t finish this review.")).toBeVisible();
      await expect(page.locator("body")).toHaveAttribute(calls, "2");
      await expect(review.getByText("72 / 100")).toHaveCount(0);

      await review.getByRole("button", { name: "Turn off automatic review" }).click();
      await expect(enable).toBeEnabled();
      await page.getByRole("button", { name: "Find an advisor" }).click();
      await expect(page.getByRole("dialog").getByText("Sample advisor", { exact: true })).toBeVisible();
    });
  }

  test("Finance portfolio review keeps two cards without a qualifying stock or history", async ({ page }, info) => {
    await mount(page, 960);
    await page.evaluate(() => { document.body.dataset.portfolioReviewFundAndCash = "true"; });
    await page.getByRole("button", { name: "Toggle sample analysis" }).click();
    const analysis = page.getByTestId("portfolio-analysis");
    const mix = analysis.getByRole("heading", { name: "Portfolio mix" });
    const scenario = analysis.getByRole("heading", { name: "What if your investments fall?" });
    await expect(scenario).toBeVisible();
    await expect(analysis.getByRole("heading")).toHaveCount(2);
    await expect(analysis.getByText("−9.1%")).toBeVisible();
    const [first, second] = await Promise.all([mix.boundingBox(), scenario.boundingBox()]);
    expect(Math.abs(first!.y - second!.y)).toBeLessThan(2);
    expect(second!.x).toBeGreaterThan(first!.x);
    await analysis.screenshot({ path: info.outputPath("portfolio-two-cards.png") });
  });

  test("Finance portfolio review reopens the saved result without another model request", async ({ page }) => {
    await mount(page, 960);
    await page.getByRole("button", { name: "Toggle sample analysis" }).click();
    const review = page.getByRole("region", { name: "Portfolio review", exact: true });
    const allow = review.getByRole("button", { name: "Allow portfolio review" });
    await allow.click();
    await expect(review.getByText("72 / 100")).toBeVisible();

    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, value: true });
      document.dispatchEvent(new Event("visibilitychange"));
      Object.defineProperty(document, "hidden", { configurable: true, value: false });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect(review.getByText("72 / 100")).toBeVisible();
    await expect(allow).toHaveCount(0);
    await expect(review.getByRole("button", { name: "Turn off automatic review" })).toHaveCount(0);
    await expect(page.locator("body")).toHaveAttribute("data-portfolio-review-calls", "1");

    await page.getByRole("button", { name: "Update sample portfolio" }).click();
    await expect(review.getByText("72 / 100")).toHaveCount(0);
    await expect(allow).toBeEnabled();
    await expect(page.locator("body")).toHaveAttribute("data-portfolio-review-calls", "1");
  });

  test("Finance advisor scheduling uses a rounded time picker and scrollable time zones", async ({ page, browserName, isMobile }, info) => {
    await mount(page, isMobile ? 393 : 960);
    await page.getByRole("button", { name: "Open sample advisor request" }).click();
    await page.getByRole("button", { name: "Accept & connect" }).click();
    const workspace = page.getByRole("dialog", { name: "Advisor review" });
    const readPicker = (name: string) => workspace.getByRole("button", { name, exact: true }).evaluate((button) => {
      const label = button.firstElementChild!;
      const style = getComputedStyle(label);
      const box = button.getBoundingClientRect();
      const content = label.getBoundingClientRect();
      return {
        type: [style.fontFamily, style.fontSize, style.fontWeight, style.lineHeight],
        centerOffset: content.left + content.width / 2 - box.left - box.width / 2,
        centerY: content.top + content.height / 2,
        iconFirst: label.firstElementChild?.tagName.toLowerCase() === "svg",
      };
    });
    const viewport = page.viewportSize()!;
    for (const width of [393, 960]) {
      await page.setViewportSize({ ...viewport, width });
      const [datePicker, timePicker] = await Promise.all([readPicker("Choose date"), readPicker("Choose time")]);
      expect(timePicker.type).toEqual(datePicker.type);
      expect(Math.abs(timePicker.centerY - datePicker.centerY)).toBeLessThan(2);
      for (const picker of [datePicker, timePicker]) {
        expect(Math.abs(picker.centerOffset)).toBeLessThan(2);
        expect(picker.iconFirst).toBe(true);
      }
    }
    await page.setViewportSize(viewport);
    await workspace.screenshot({ path: info.outputPath("advisor-meeting.png") });
    await workspace.getByRole("button", { name: "Choose date" }).click();
    const date = page.getByRole("dialog", { name: "Choose meeting date" });
    await expect(date).toBeVisible();
    expect(await date.evaluate((el) => parseFloat(getComputedStyle(el).borderTopLeftRadius))).toBeGreaterThan(8);
    await page.keyboard.press("Escape");
    await expect(workspace.getByRole("button", { name: "Choose date" })).toBeFocused();
    await workspace.getByRole("button", { name: "Choose time" }).click();
    const time = page.getByRole("dialog", { name: "Choose meeting time" });
    expect(await time.evaluate((el) => parseFloat(getComputedStyle(el).borderTopLeftRadius))).toBeGreaterThan(8);
    await time.getByRole("group", { name: "Hour", exact: true }).getByText("12", { exact: true }).click();
    await time.getByRole("group", { name: "Minute" }).getByText("14", { exact: true }).click();
    await time.getByRole("group", { name: "AM / PM" }).getByText("PM", { exact: true }).click();
    await time.screenshot({ path: info.outputPath("advisor-time-picker.png") });
    await time.getByRole("button", { name: "Done" }).click();
    const chosenTime = workspace.getByRole("button", { name: "Time, 12:14 PM" });
    await expect(chosenTime).toBeFocused();
    await chosenTime.click();
    await time.getByRole("group", { name: "AM / PM" }).getByText("AM", { exact: true }).click();
    await page.keyboard.press("Escape");
    await expect(chosenTime).toBeVisible();
    await workspace.getByText(/^Meeting options/).click();
    const duration = workspace.getByRole("combobox", { name: "Duration" });
    const zone = workspace.getByRole("button", { name: /^Time zone,/ });
    const [durationBox, zoneBox] = await Promise.all([duration.boundingBox(), zone.boundingBox()]);
    expect(Math.abs(durationBox!.y - zoneBox!.y)).toBeLessThan(1);
    expect(zoneBox!.x).toBeGreaterThanOrEqual(durationBox!.x + durationBox!.width - 1);
    await duration.click();
    const durations = page.getByRole("listbox");
    expect(await durations.evaluate((el) => parseFloat(getComputedStyle(el).borderTopLeftRadius))).toBeGreaterThan(8);
    await durations.getByRole("option", { name: "60 minutes" }).click();
    await zone.click();
    const timeZones = page.getByRole("dialog", { name: "Choose time zone" }).getByRole("listbox");
    await expect(timeZones).toBeVisible();
    const initialScroll = await timeZones.evaluate((list) => list.scrollTop);
    if (browserName === "chromium" && await page.evaluate(() => navigator.maxTouchPoints > 0)) {
      const box = (await timeZones.boundingBox())!;
      const x = Math.round(box.x + box.width / 2);
      const y = Math.round(box.y + box.height - 20);
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
      for (const distance of [25, 50, 75, 100]) {
        await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y - distance }] });
      }
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await cdp.detach();
    } else {
      await timeZones.hover();
      await page.mouse.wheel(0, 400);
    }
    await expect.poll(() => timeZones.evaluate((list) => list.scrollTop)).toBeGreaterThan(initialScroll);
    await page.getByRole("combobox", { name: "Search time zone" }).fill("Mumbai");
    await page.getByRole("option", { name: /Kolkata.*UTC\+05:30/ }).click();
    await expect(zone).toHaveAccessibleName(/Kolkata/);
  });

  test("Finance advisor Calendar status refreshes on return and verifies a confirmed event", async ({ page }) => {
    await mount(page, 393);
    await page.evaluate(() => { document.body.dataset.advisorMeeting = "confirmed"; });
    await page.getByRole("button", { name: "Open sample agreed meeting" }).click();
    const workspace = page.getByRole("dialog", { name: "Advisor review" });
    await expect(workspace.getByRole("link", { name: "Connect Calendar" })).toBeVisible();
    await page.evaluate(() => {
      document.body.dataset.advisorCalendar = "connected";
      window.dispatchEvent(new Event("focus"));
    });
    const badge = workspace.getByText("synthetic-advisor@example.test");
    await expect(badge).toBeVisible();
    expect(await badge.locator("span").evaluate((dot) => getComputedStyle(dot).backgroundColor)).toBe("rgb(40, 120, 74)");
    await expect(workspace.getByRole("link", { name: "Manage Calendar" })).toBeVisible();
    await workspace.getByRole("button", { name: "More meeting actions" }).click();
    await page.getByRole("menuitem", { name: "Check Calendar status" }).click();
    await expect(workspace.getByText("Checked just now · Still on Google Calendar")).toBeVisible();
  });

  for (const width of [393, 1440])
    for (const theme of ["light", "dark"]) {
      test(`Finance advisor request locks snapshot until acceptance at ${width}px ${theme}`, async ({
        page,
      }, info) => {
        await page.emulateMedia({ reducedMotion: "reduce" });
        await mount(page, width);
        await page.evaluate(
          (theme) =>
            document.documentElement.classList.toggle("dark", theme === "dark"),
          theme,
        );
        await page
          .getByRole("button", {
            name: "Open sample advisor request",
            exact: true,
          })
          .click();
        const dialog = page.getByRole("dialog");
        await expect(dialog).toHaveCount(1);
        await expect(dialog.getByText(/snapshot stays sealed/i)).toBeVisible();
        await expect(
          dialog.getByRole("heading", { name: "Finance snapshot" }),
        ).toHaveCount(0);
        expect(
          await page.evaluate(() => document.body.dataset.advisorDecrypts),
        ).toBeUndefined();
        await dialog.getByRole("button", { name: "Accept & connect" }).click();
        await expect(dialog.getByRole("button", { name: "Choose date", exact: true })).toBeVisible();
        await expect(dialog.getByRole("heading", { name: "Finance snapshot" })).toHaveCount(0);
        await dialog.getByRole("tab", { name: "Portfolio", exact: true }).click();
        await expect(
          dialog.getByRole("heading", { name: "Finance snapshot" }),
        ).toBeVisible();
        expect(
          await dialog
            .getByRole("heading", { name: "Finance snapshot" })
            .evaluate((el) => getComputedStyle(el).fontSize),
        ).toBe("14px");
        await dialog.getByRole("tab", { name: "Meeting", exact: true }).click();
        await expect(
          dialog.getByRole("link", { name: "Connect Calendar" }),
        ).toHaveAttribute("href", "/one/calendar");
        await dialog.getByRole("tab", { name: "Plan", exact: true }).click();
        await expect(dialog.getByRole("button", { name: "Set up test payouts" })).toBeEnabled();
        await dialog.getByRole("tab", { name: "Meeting", exact: true }).click();
        const titleBox = (await dialog.getByRole("heading", { name: "Advisor review", exact: true }).boundingBox())!;
        const closeBox = (await dialog.getByRole("button", { name: "Close", exact: true }).boundingBox())!;
        expect(Math.abs(titleBox.y + titleBox.height / 2 - closeBox.y - closeBox.height / 2)).toBeLessThan(8);
        expect(
          await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth),
        ).toBe(true);
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        await dialog.screenshot({
          path: info.outputPath(`advisor-workspace-${width}-${theme}.png`),
        });
      });
      test(`Finance advisor request reuses an uncertain send and Calendar recovery at ${width}px ${theme}`, async ({
        page,
      }) => {
        await mount(page, width);
        await page.evaluate((theme) => {
          document.documentElement.classList.toggle("dark", theme === "dark");
          document.body.dataset.advisorAck = "uncertain";
        }, theme);
        await page
          .getByRole("button", { name: "Start sample advisor request" })
          .click();
        const dialog = page.getByRole("dialog");
        await dialog
          .getByRole("button", { name: "Choose", exact: true })
          .click();
        await dialog.getByText("Preview shared portfolio", { exact: true }).click();
        await expect(
          dialog.getByRole("heading", { name: "Finance snapshot" }),
        ).toBeVisible();
        const send = dialog.getByRole("button", {
          name: "Send request",
          exact: true,
        });
        await expect(send).toBeDisabled();
        await dialog.getByRole("checkbox").check();
        await send.click();
        await expect(dialog.getByRole("alert")).toBeVisible();
        await dialog
          .getByRole("button", { name: "Retry same request" })
          .click();
        await expect(
          dialog.getByRole("button", { name: "Cancel request" }),
        ).toBeVisible();
        expect(
          await page.evaluate(() => ({
            prepare: document.body.dataset.advisorPrepares,
            sends: document.body.dataset.advisorSends,
          })),
        ).toEqual({ prepare: "1", sends: "2" });
        await dialog
          .getByRole("button", { name: /^Close(?: detail panel)?$/ })
          .click();
        await page
          .getByRole("button", { name: "Open sample agreed meeting" })
          .click();
        await page
          .getByRole("dialog")
          .getByRole("button", { name: "Review Calendar booking" })
          .click();
        await expect(page.getByRole("alert")).toContainText(
          "Connect Google Calendar",
        );
        await expect(
          page.getByRole("button", { name: "Confirm meeting" }),
        ).toHaveCount(0);
      });
    }
}
