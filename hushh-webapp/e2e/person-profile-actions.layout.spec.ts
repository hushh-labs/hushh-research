import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { awaitProductFont } from "./fixtures/product-font";
import { buildPersonProfileBrowserFixture, type PersonProfileBrowserFixture } from "./fixtures/person-profile-browser";

let css: string;
let script: string;
let requestScript: string;
let fixture: PersonProfileBrowserFixture | undefined;

/** Real profile presentation, optimized app CSS and shipped font.
 * Controller, authorization and request-lifetime contracts remain in the component suite.
 */
async function setFixtureContent(page: Page, content: string) {
  await page.setContent(content.replace("<head>", '<head><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">'));
}

test.beforeAll(async () => {
  test.setTimeout(120_000);
  fixture = await buildPersonProfileBrowserFixture();
  ({ css, script, requestScript } = fixture);
});

test.afterAll(() => fixture?.dispose());

async function openFixture(page: Page, width: number, theme = "light") {
  await page.setViewportSize({ width, height: 900 });
  await setFixtureContent(page, `<html class="${theme}"><head><style>${css}</style></head><body><div id="root"></div></body></html>`);
  await page.addScriptTag({ content: script });
  await expect(page.getByRole("heading", { name: "Aarav Sharma" })).toBeVisible();
  await awaitProductFont(page);
}

const taskIds = ["request-files", "ask-about-files", "request-scope", "request-cards"];

for (const [width, height] of [[320, 568], [390, 844], [844, 390], [1280, 900]]) {
  test(`information request has aligned selection and reachable fields at ${width}x${height}`, async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await openFixture(page, width);
    await page.setViewportSize({ width, height });
    const search = page.getByRole("searchbox", { name: "Search this list" });
    await search.fill("Professional details");
    const row = page.getByTestId("consent-scope-row-synthetic-Professional");
    const checkbox = row.getByRole("checkbox", { name: "Professional details" });
    await checkbox.check();
    const alignment = await row.evaluate(el => {
      const row = el.getBoundingClientRect(), check = el.querySelector('input[type="checkbox"]')!.getBoundingClientRect();
      return Math.abs((row.top + row.bottom) / 2 - (check.top + check.bottom) / 2);
    });
    expect(alignment).toBeLessThanOrEqual(1);
    await search.focus();
    expect(await search.evaluate(el => getComputedStyle(el.parentElement!).boxShadow)).toBe("none");
    await page.getByRole("button", { name: "Clear search" }).click();
    await expect(search).toHaveValue("");
    await page.getByRole("button", { name: "Review request", exact: true }).click();
    const dialog = page.getByRole("dialog");
    const purpose = dialog.getByTestId("person-profile-purpose");
    const send = dialog.getByRole("button", { name: "Send request", exact: true });
    await expect(send).toBeDisabled();
    await expect(purpose).toBeInViewport();
    await purpose.fill("Preparing for our meeting");
    const duration = dialog.getByRole("radio", { name: "3 days", exact: true });
    await duration.click();
    await expect(duration).toHaveAttribute("aria-checked", "true");
    await duration.focus();
    await page.keyboard.press("End");
    await expect(dialog.getByRole("radio", { name: "30 days", exact: true })).toBeChecked();
    await page.keyboard.press("ArrowLeft");
    await expect(dialog.getByRole("radio", { name: "7 days", exact: true })).toBeChecked();
    await page.keyboard.press("Home");
    await expect(dialog.getByRole("radio", { name: "1 day", exact: true })).toBeChecked();
    await duration.click();
    await expect(send).toBeEnabled();
    await expect(send).toBeInViewport();
    await expect.poll(() => dialog.evaluate(el => getComputedStyle(el).opacity)).toBe("1");
    const frame = await dialog.boundingBox();
    expect(frame!.x).toBeGreaterThanOrEqual(0);
    expect(frame!.y).toBeGreaterThanOrEqual(0);
    expect(frame!.y + frame!.height).toBeLessThanOrEqual(height + 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
    if (width === 390) await page.screenshot({ path: testInfo.outputPath("information-review.png") });
    await send.click();
    await expect(page.getByRole("status").filter({ hasText: "Sample request sent" })).toBeVisible();
    expect(errors).toEqual([]);
  });
}

async function boxes(page: Page) {
  return page.evaluate(() => Object.fromEntries([...document.querySelectorAll<HTMLElement>("[data-id]")].map((el) => {
    const { top, bottom, left, right, width, height } = el.getBoundingClientRect();
    return [el.dataset.id!, { top, bottom, left, right, width, height }];
  })));
}

for (const width of [320, 393, 768, 1024, 1440]) {
  for (const theme of ["light", "dark"]) {
    test(`v16 typography and actions fit ${width}px in ${theme}`, async ({ page }, testInfo) => {
      await openFixture(page, width, theme);
      const geometry = await page.locator("[data-profile-fixture]").evaluate((root) => {
        const hero = root.firstElementChild!;
        const cover = hero.firstElementChild!;
        const avatar = hero.querySelector('[data-slot="avatar"]')!;
        const footer = hero.querySelector('[class*="heroFooter"]')!;
        const title = root.querySelector("h1")!;
        const section = root.querySelector("h2")!;
        const empty = [...root.querySelectorAll("section")].find(node => node.textContent === "Nothing shared yet")!;
        const style = (el: Element) => {
          const value = getComputedStyle(el);
          return { size: value.fontSize, line: value.lineHeight, weight: value.fontWeight, radius: value.borderRadius };
        };
        const rect = (el: Element) => {
          const { left, width, height, top, bottom } = el.getBoundingClientRect();
          return { left, width, height, top, bottom };
        };
        return { title: style(title), section: style(section), hero: style(hero), cover: rect(cover), avatar: rect(avatar),
          footerBorder: getComputedStyle(footer).borderTopWidth,
          empty: rect(empty), shell: rect(root.parentElement!), heroBox: rect(hero), titleBox: rect(title),
          historyTitle: rect(root.querySelector('[class*="historyTitle"]')!),
          pagination: style(root.querySelector('[class*="pagination"] > span')!),
          search: style(root.querySelector('input[placeholder="Search categories"]')!) };
      });
      expect(geometry.title).toMatchObject({ size: width < 768 ? "24px" : "28px", line: width < 768 ? "32px" : "36px", weight: "600" });
      expect(geometry.section).toMatchObject({ size: width < 768 ? "17px" : "20px", line: width < 768 ? "25px" : "28px", weight: "600" });
      expect(geometry.search.size).toBe(width < 768 ? "16px" : "14px");
      expect(geometry.hero.radius).toBe(width < 768 ? "20px" : "24px");
      expect(geometry.cover.height).toBe(width < 768 ? 94 : 120);
      expect(geometry.avatar.width).toBe(width < 768 ? 64 : 76);
      expect(geometry.cover.bottom - geometry.avatar.top).toBe(width < 768 ? 24 : 30);
      expect(geometry.footerBorder).toBe("0px");
      expect(geometry.titleBox.left - geometry.heroBox.left).toBe(width < 768 ? 17 : 25);
      expect(geometry.empty.height).toBe(width < 768 ? 62 : 68);
      expect(geometry.historyTitle.width).toBeGreaterThanOrEqual(160);
      expect(geometry.historyTitle.height).toBeLessThanOrEqual(40);
      expect(geometry.pagination).toMatchObject({ size: "12px", line: "18px" });
      expect(geometry.shell.width).toBeLessThanOrEqual(880);
      const rect = await boxes(page);
      expect(rect.connected.height).toBeGreaterThanOrEqual(44);
      expect(rect.connected.top).toBeGreaterThanOrEqual(geometry.cover.bottom);
      expect(rect.connected.right).toBeLessThanOrEqual(geometry.heroBox.left + geometry.heroBox.width);
      expect(rect.request.height).toBe(44);
      expect(rect.share.height).toBe(44);
      expect(Math.abs(rect.request.top - rect.share.top)).toBeLessThan(1);
      for (const id of taskIds) {
        expect(rect[id].height).toBeGreaterThanOrEqual(60);
        expect(rect[id].width).toBeCloseTo(rect[taskIds[0]].width, 0);
        const task = await page.locator(`[data-id="${id}"]`).evaluate(el => ({
          radius: getComputedStyle(el).borderRadius,
          size: getComputedStyle(el).fontSize,
          icon: el.querySelector('[data-tone] svg')!.getBoundingClientRect().width,
        }));
        expect(task.radius).toBe("14px");
        expect(task.size).toBe(width >= 768 && width < 1024 ? "13px" : "12px");
        expect(task.icon).toBe(17);
      }
      expect(Math.abs(rect[taskIds[0]].top - rect[taskIds[1]].top)).toBeLessThan(1);
      if (width >= 1024) expect(Math.abs(rect[taskIds[0]].top - rect[taskIds[3]].top)).toBeLessThan(1);
      else expect(rect[taskIds[2]].top).toBeGreaterThanOrEqual(rect[taskIds[0]].bottom);
      expect(rect.manage.top - rect[taskIds[3]].bottom).toBeGreaterThanOrEqual(12);
      expect(rect.manage.height).toBeGreaterThanOrEqual(44);
      expect(rect.review.height).toBe(44);
      expect(rect.review.width).toBeLessThan(250);
      expect(await page.locator('[data-id="review"]').evaluate(el => getComputedStyle(el.parentElement!).position)).toBe("static");
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
      if ([393, 1440].includes(width) && theme === "light") await page.screenshot({ path: testInfo.outputPath("profile-v16.png") });
      await page.locator('[data-id="review"]').scrollIntoViewIfNeeded();
      await expect(page.locator('[data-id="review"]')).toBeInViewport();
      if (width === 393 && theme === "light") await page.screenshot({ path: testInfo.outputPath("profile-v16-lower.png") });
    });
  }
}

for (const width of [320, 1024]) {
  test(`Connected menu stays usable below the cover at ${width}px`, async ({ page }) => {
    await openFixture(page, width);
    const trigger = page.getByRole("button", { name: "Connected, connection options" });
    await trigger.click();
    await expect(page.getByRole("menuitem", { name: "Remove connection" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
  });
}

for (const width of [320, 393]) {
  test(`catalog checkbox stays beside its label at ${width}px`, async ({ page }) => {
    await openFixture(page, width);
    await page.getByRole("button", { name: "Open Professional" }).click();
    const row = page.getByTestId("consent-scope-row-synthetic-Professional");
    const title = row.locator('[data-slot="settings-row-title"]');
    const checkbox = row.getByRole("checkbox", { name: "Professional details" });
    await expect(checkbox).toBeVisible();
    await title.evaluate((node) => { node.textContent = "Professional details with a much longer description"; });
    const geometry = await row.evaluate((node) => {
      const rect = (element: Element) => {
        const { left, right, top, bottom } = element.getBoundingClientRect();
        return { left, right, top, bottom };
      };
      return {
        row: rect(node),
        title: rect(node.querySelector('[data-slot="settings-row-title"]')!),
        checkbox: rect(node.querySelector('input[type="checkbox"]')!),
      };
    });
    expect(geometry.title.right).toBeLessThan(geometry.checkbox.left);
    expect(Math.abs((geometry.title.top + geometry.title.bottom) / 2 - (geometry.checkbox.top + geometry.checkbox.bottom) / 2)).toBeLessThan(2);
    expect(geometry.checkbox.right).toBeLessThan(geometry.row.right);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  });
}

for (const [width, height] of [[320, 568], [390, 844]]) {
  test(`information review choices and long labels fit ${width}x${height}`, async ({ page }) => {
    await openFixture(page, width);
    await page.setViewportSize({ width, height });
    await page.locator('[data-id="review"]').click();
    const dialog = page.getByRole("dialog", { name: "Request information from Aarav Sharma" });
    await expect(dialog).toBeVisible();
    await expect.poll(() => dialog.evaluate((node) => node.getBoundingClientRect().width / node.offsetWidth)).toBeGreaterThan(0.999);
    await expect(dialog.getByRole("group", { name: "Access duration" })).toBeVisible();
    const selected = dialog.getByRole("radio", { name: "7 days" });
    await expect(selected).toBeChecked();
    const optionBoxes = await dialog.getByRole("radio").evaluateAll((inputs) => inputs.map((input) => {
      const { left, right, top, bottom, height } = input.getBoundingClientRect();
      return { left, right, top, bottom, height };
    }));
    expect(optionBoxes).toHaveLength(4);
    expect(optionBoxes[0]!.height).toBeGreaterThanOrEqual(44);
    expect(optionBoxes[0]!.top).toBeCloseTo(optionBoxes[1]!.top, 0);
    expect(optionBoxes[2]!.top).toBeGreaterThanOrEqual(optionBoxes[0]!.bottom);
    const geometry = await dialog.evaluate((node) => {
      const dialogBox = node.getBoundingClientRect();
      const row = node.querySelector('[data-testid="person-profile-scope-row-synthetic-wallet-summary"]')!;
      const rowBox = row.getBoundingClientRect();
      const label = row.firstElementChild!.getBoundingClientRect();
      const pill = row.lastElementChild!.getBoundingClientRect();
      return {
        dialogLeft: dialogBox.left, dialogRight: dialogBox.right, dialogBottom: dialogBox.bottom,
        labelLeft: label.left, labelRight: label.right, pillLeft: pill.left, pillRight: pill.right,
        rowLeft: rowBox.left, rowRight: rowBox.right, rowOverflow: row.scrollWidth - row.clientWidth,
      };
    });
    expect(geometry.dialogLeft).toBeGreaterThanOrEqual(0);
    expect(geometry.dialogRight).toBeLessThanOrEqual(width);
    expect(geometry.dialogBottom).toBeLessThanOrEqual(height);
    expect(geometry.labelLeft).toBeGreaterThanOrEqual(geometry.rowLeft);
    expect(geometry.labelRight).toBeLessThanOrEqual(geometry.pillLeft);
    expect(geometry.pillRight).toBeLessThanOrEqual(geometry.rowRight);
    expect(geometry.rowOverflow).toBeLessThanOrEqual(0);
    await dialog.getByRole("radio", { name: "1 day", exact: true }).click();
    await expect(dialog.getByRole("radio", { name: "1 day" })).toBeChecked();
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeInViewport();
  });
}

test("long mixed-direction details, sparse actions and focus remain usable at 320px", async ({ page, browserName }) => {
  await openFixture(page, 320);
  await page.locator("h1").evaluate(el => { el.textContent = "Alexandria-Rose Sharma — عائشة الأحمد"; });
  await page.locator('a[href^="mailto:"] span').evaluate(el => { el.textContent = "alexandria.rose.extended@example.test"; });
  await page.locator('[data-id="request-cards"] [data-tone] > span:nth-child(2)').evaluate(el => { el.textContent = "Card request sent — طلب مشاركة البطاقة"; });
  await page.locator('[data-id="request-files"], [data-id="ask-about-files"]').evaluateAll(elements => elements.forEach(el => el.remove()));
  let rect = await boxes(page);
  expect(Math.abs(rect["request-scope"].top - rect["request-cards"].top)).toBeLessThan(1);
  expect(rect.manage.top).toBeGreaterThanOrEqual(rect["request-cards"].bottom);
  expect(await page.locator('[data-id="request-cards"]').evaluate(el => {
    const label = el.querySelector('[data-tone] > span:nth-child(2)')!;
    const range = document.createRange(); range.selectNodeContents(label);
    const text = range.getBoundingClientRect(), card = el.getBoundingClientRect();
    return text.left >= card.left && text.right <= card.right && text.bottom <= card.bottom;
  })).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  // WebKit's macOS full keyboard access uses Option+Tab to include buttons.
  for (let i = 0; i < 6; i++) await page.keyboard.press(browserName === "webkit" ? "Alt+Tab" : "Tab");
  const question = page.getByRole("button", { name: "Ask a question", exact: true });
  await expect(question).toBeFocused();
  expect(await question.evaluate(el => getComputedStyle(el).boxShadow)).not.toBe("none");
  await page.locator('[data-id="share"]').evaluate(el => {
    el.parentElement!.setAttribute("data-share-only", "true");
    el.parentElement!.querySelector('[data-id="request"]')!.remove();
  });
  rect = await boxes(page);
  expect(rect.share.width).toBeCloseTo(await page.locator('[data-id="share"]').evaluate(el => el.parentElement!.getBoundingClientRect().width), 0);
});


async function openRequests(page: Page, width: number, height: number, theme = "light", probe = false) {
  await page.setViewportSize({ width, height });
  await page.route("https://profile-fixture.test/onboarding/intro-v2/*-poster.png", route => route.fulfill({
    contentType: "image/png", body: fs.readFileSync(path.join(process.cwd(), "public/onboarding/intro-v2", path.basename(route.request().url()))),
  }));
  await page.route("https://profile-fixture.test/?*", route => route.fulfill({ contentType: "text/html",
    body: `<html class="${theme}"><head><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><style>${css}</style></head><body><div id="root"></div></body></html>`,
  }));
  await page.goto(`https://profile-fixture.test/?perf=${probe ? "1" : "0"}`);
  await page.addScriptTag({ content: requestScript });
  await expect(page.getByRole("button", { name: "Request files", exact: true })).toBeVisible();
  await awaitProductFont(page);
}
const requestIntents = [
  { trigger: "Request files", title: "Request files", intent: "files" },
  { trigger: "Ask about files", title: "Ask about files", intent: "drive" },
  { trigger: "Request scope", title: "Ask a question", intent: "question" },
  { trigger: "Request cards", title: "Request a card", intent: "card" },
];
for (const [width, height] of [[320, 568], [390, 844], [768, 1024], [1440, 900], [844, 390]]) {
  for (const theme of ["light", "dark"]) {
    test(`v18 real request dialogs fit ${width}x${height} in ${theme}`, async ({ page }, testInfo) => {
      await openRequests(page, width, height, theme, width === 390 && theme === "light");
      for (const { trigger, title, intent } of requestIntents) {
        const opener = page.getByRole("button", { name: trigger, exact: true });
        await opener.click();
        const dialog = page.getByRole("dialog", { name: title, exact: true });
        await expect(dialog).toBeVisible();
        const cancel = dialog.getByRole("button", { name: "Cancel", exact: true });
        await expect(cancel).toBeInViewport();
        // Settle the shared enter animation before measuring production geometry.
        await expect.poll(() => dialog.evaluate(el => getComputedStyle(el).opacity)).toBe("1");
        const state = await dialog.evaluate(el => {
          const r = el.getBoundingClientRect(), title = el.querySelector('[data-slot="dialog-title"]')!;
          const t = getComputedStyle(title), overlay = getComputedStyle(document.querySelector('[data-slot="dialog-overlay"]')!);
          return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width,
            size: t.fontSize, line: t.lineHeight, weight: t.fontWeight,
            consentPresentation: el.classList.contains("consent-presentation-surface"),
            blur: overlay.backdropFilter, surface: getComputedStyle(el).backgroundColor,
            duplicateIds: [...el.querySelectorAll("[id]")].some(node => document.querySelectorAll(`[id="${CSS.escape(node.id)}"]`).length > 1),
            overflow: el.scrollWidth - el.clientWidth,
            controls: [...el.querySelectorAll<HTMLElement>("textarea,input,button,select")].filter(node => node.getClientRects().length && !node.hasAttribute("data-slot")).map(node => {
              const box = node.getBoundingClientRect(); return { left: box.left, right: box.right, height: box.height };
            }),
          };
        });
        expect(state.left).toBeGreaterThanOrEqual(-1);
        expect(state.right).toBeLessThanOrEqual(width + 1);
        expect(state.top).toBeGreaterThanOrEqual(-1);
        expect(state.bottom).toBeLessThanOrEqual(height + 1);
        expect(state.width).toBeCloseTo(width < 768 ? width : 480, 0);
        expect(state.consentPresentation).toBe(intent !== "card");
        expect(state).toMatchObject({
          size: "20px",
          line: "28px",
          weight: "600",
          duplicateIds: false,
        });
        expect(state.blur).toBe(width < 640 ? "blur(4px)" : "blur(12px)");
        expect(state.surface).toMatch(/^rgb\(/);
        expect(state.overflow).toBeLessThanOrEqual(1);
        for (const control of state.controls) {
          expect(control.left).toBeGreaterThanOrEqual(state.left - 1);
          expect(control.right).toBeLessThanOrEqual(state.right + 1);
          expect(control.height).toBeGreaterThanOrEqual(44);
        }
        if ([390, 1440].includes(width)) await page.screenshot({ path: testInfo.outputPath(`profile-v18-${intent}.png`) });
        await cancel.click();
        await expect(dialog).toBeHidden();
        await expect(opener).toBeFocused();
      }
      if (width === 390 && theme === "light") {
        const report = testInfo.outputPath("profile-v18-frame-probe.json");
        fs.writeFileSync(report, await page.evaluate(() => window.__hushhPerf?.export() ?? "{}"));
        await testInfo.attach("profile-v18-frame-probe", { path: report, contentType: "application/json" });
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
    });
  }
}

test("v18 320px open date calendar retains 44px targets without clipping", async ({ page }, testInfo) => {
  await openRequests(page, 320, 568);
  await page.getByRole("button", { name: "Request files", exact: true }).click();
  await page.getByRole("button", { name: "Start date: Choose date" }).click();
  const days = page.locator("[data-calendar-days] button");
  await expect(days.first()).toBeVisible();
  const regions = await page.locator('[data-task-region="body"]').evaluate(el => ({
    width: el.getBoundingClientRect().width, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth,
    calendar: document.querySelector("#mobile-document-calendar")!.getBoundingClientRect().toJSON(),
  }));
  await testInfo.attach("calendar-geometry", { body: JSON.stringify(regions), contentType: "application/json" });
  await page.screenshot({ path: testInfo.outputPath("profile-v18-calendar.png") });
  expect(regions.scrollWidth).toBeLessThanOrEqual(regions.clientWidth);
  const layout = await days.evaluateAll(nodes => nodes.map(node => {
    const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width, height: r.height, top: r.top };
  }));
  for (let i = 1; i < layout.length; i++) {
    if (layout[i].top === layout[i - 1].top) expect(layout[i - 1].right).toBeLessThanOrEqual(layout[i].left + 0.1);
  }
  for (const r of layout) {
    expect(r.left).toBeGreaterThanOrEqual(0);
    expect(r.right).toBeLessThanOrEqual(320);
    expect(r.width).toBeGreaterThanOrEqual(44);
    expect(r.height).toBeGreaterThanOrEqual(44);
  }
  await days.first().click();
  await expect(page.getByRole("group", { name: "Choose end date" })).toBeVisible();
  await days.last().click();
  await expect(page.locator("#mobile-document-calendar")).toBeHidden();
});

test("v18 acknowledged results preserve follow-ups, busy dismissal and focus", async ({ page }) => {
  await openRequests(page, 390, 844);
  for (const item of requestIntents) {
    await page.getByRole("button", { name: item.trigger, exact: true }).click();
    const dialog = page.getByRole("dialog");
    if (item.intent === "files") {
      await dialog.getByLabel("Which files do you need?").fill("Bank statements");
      await dialog.getByRole("button", { name: "Start date: Choose date" }).click();
      await page.locator("[data-calendar-days] button").first().click();
      await page.locator("[data-calendar-days] button").last().click();
    } else if (item.intent !== "card") await dialog.getByLabel("Your question").fill("Which details can you share?");
    await page.evaluate(() => { window.profileRequests.hold = true; });
    await dialog.getByRole("button", { name: "Send request", exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.profileRequests.calls.at(-1))).toBe(item.intent);
    await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("heading", { name: /sent/ })).toHaveCount(0);
    await page.evaluate(() => window.profileRequests.accept());
    if (item.intent === "card") {
      await expect(dialog).toBeHidden();
      await expect(page.getByRole("button", { name: "Card request sent" })).toBeDisabled();
      await expect(page.getByRole("button", { name: "Share profile" })).toBeFocused();
    } else {
      await expect(dialog.getByRole("heading", { name: item.intent === "files" ? "Request sent" : "Question sent", exact: true })).toBeFocused();
      await expect(dialog.getByRole("link", { name: item.intent === "drive" ? "View question" : "View request", exact: true })).toBeVisible();
      await expect(dialog.getByRole("button", { name: item.intent === "files" ? "Request more files" : "Ask another question", exact: true })).toBeVisible();
      await dialog.getByRole("button", { name: "Close", exact: true }).click();
    }
  }
});

test("v18 phone keyboard and acknowledged native overlay seats keep actions reachable", async ({ page }) => {
  await openRequests(page, 390, 844);
  await page.evaluate(() => {
    document.documentElement.classList.add("kb-open");
    document.documentElement.style.setProperty("--kb-height", "300px");
  });
  await page.getByRole("button", { name: "Request scope", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeInViewport();
  await expect.poll(() => dialog.evaluate(el => Math.round(el.getBoundingClientRect().bottom))).toBe(544);
  await dialog.getByLabel("Your question").fill("A question while the keyboard is up");
  await page.evaluate(() => {
    document.documentElement.classList.add("native-reserved-chrome");
    document.documentElement.style.setProperty("--native-overlay-top", "60px");
    document.documentElement.style.setProperty("--native-overlay-bottom", "100px");
  });
  const seat = await dialog.evaluate(el => ({ top: el.getBoundingClientRect().top, bottom: el.getBoundingClientRect().bottom }));
  expect(seat.top).toBeGreaterThanOrEqual(60);
  expect(seat.bottom).toBeLessThanOrEqual(544);
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeInViewport();
});
