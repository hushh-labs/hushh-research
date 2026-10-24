import { expect, test } from "@playwright/test";

import { awaitProductFont } from "./fixtures/product-font";
import { buildMailWorkspaceFixture } from "./fixtures/build-mail-workspace";

let script: string;
let css: string;
let disposeFixture: (() => void) | undefined;

test.beforeAll(async () => {
  const fixture = await buildMailWorkspaceFixture();
  script = fixture.script;
  css = fixture.css;
  disposeFixture = fixture.dispose;
});

test.afterAll(() => disposeFixture?.());

for (const width of [360, 393, 430, 768, 1024, 1440]) {
  for (const theme of ["light", "dark"] as const) {
    for (const workspace of ["overview", "kyc", "receipts"] as const) {
      test(`Mail ${workspace} ${theme} at ${width}px uses the Connect frame`, async ({ page }, testInfo) => {
        await page.setViewportSize({ width, height: width >= 768 ? 1000 : 852 });
        await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
        const errors: string[] = [];
        page.on("pageerror", error => errors.push(error.message));
        await page.route("http://localhost/fixture.js", route => route.fulfill({ contentType: "application/javascript; charset=utf-8", body: script }));
        await page.route("http://localhost/mail-workspace", route => route.fulfill({
          contentType: "text/html; charset=utf-8",
          body: `<!doctype html><html class="${theme}" data-workspace="${workspace}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`,
        }));
        await page.goto("http://localhost/mail-workspace");
        await expect(page.getByRole("tablist", { name: "Gmail workspace" })).toBeVisible();
        await awaitProductFont(page);
        const frame = page.locator(".app-page-shell");
        const geometry = await frame.evaluate(element => ({ width: element.getBoundingClientRect().width, gutter: parseFloat(getComputedStyle(element).paddingLeft) }));
        expect(geometry.width).toBe(Math.min(width, 728));
        expect(geometry.gutter).toBe(width <= 350 ? 16 : width <= 620 ? 20 : 24);
        const header = page.getByTestId("top-app-bar-breadcrumb-trail");
        await expect(header).toHaveText("Mail");
        const title = await header.locator("span").last().evaluate(element => { const style = getComputedStyle(element); return [style.fontSize, style.lineHeight, style.fontWeight]; });
        expect(title).toEqual(["17px", "22px", "600"]);
        const tabs = page.getByRole("tablist", { name: "Gmail workspace" });
        expect((await tabs.boundingBox())!.height).toBe(36);
        const tabType = await tabs.locator("[data-ui-contract=required-title]").first().evaluate(element => { const style = getComputedStyle(element); return [style.fontSize, style.lineHeight, style.fontWeight]; });
        expect(tabType).toEqual(["15px", "20px", "550"]);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
        if (workspace === "overview") {
          const chat = page.getByRole("button", { name: "Chat with One", exact: true });
          await expect(chat).toBeVisible();
          const appearance = await chat.evaluate(element => { const style = getComputedStyle(element); return [style.fontSize, style.lineHeight, style.fontWeight, element.getBoundingClientRect().height]; });
          expect(appearance).toEqual(["12px", "18px", "550", 44]);
          const hero = page.getByRole("heading", { name: "Draft with One." });
          const position = await hero.boundingBox();
          const manage = page.getByRole("button", { name: "Manage", exact: true });
          await manage.click();
          const menu = page.getByRole("menu");
          await expect(menu).toBeVisible();
          expect(await hero.boundingBox()).toEqual(position);
          const box = (await menu.boundingBox())!;
          expect(box.x).toBeGreaterThanOrEqual(0);
          expect(box.x + box.width).toBeLessThanOrEqual(width);
          await page.keyboard.press("Escape");
          await expect(manage).toBeFocused();
        }
        if (workspace === "kyc") {
          const paste = page.getByRole("button", { name: "Paste details", exact: true });
          await expect(paste).toBeVisible();
          expect((await paste.boundingBox())!.height).toBe(44);
          await paste.click();
          const dialog = page.getByRole("dialog", { name: "Paste your profile details" });
          await expect(dialog).toBeVisible();
          const dialogTitle = await dialog.getByRole("heading", { name: "Paste your profile details" }).evaluate(element => {
            const style = getComputedStyle(element);
            return [style.fontSize, style.lineHeight, style.fontWeight, style.fontFamily];
          });
          expect(dialogTitle.slice(0, 3)).toEqual(["20px", "28px", "600"]);
          expect(dialogTitle[3]).toContain("Plus Jakarta Sans");
          const inputType = await dialog.getByRole("textbox", { name: "KYC details" }).evaluate(element => {
            const style = getComputedStyle(element);
            return [style.fontSize, style.lineHeight, style.fontWeight];
          });
          expect(inputType).toEqual([width <= 620 ? "16px" : "14px", "22px", "400"]);
          const utility = dialog.getByRole("button", { name: "Copy prompt to clipboard" });
          const utilityType = await utility.evaluate(element => {
            const style = getComputedStyle(element);
            return [style.fontSize, style.lineHeight, style.fontWeight, element.getBoundingClientRect().height];
          });
          expect(utilityType).toEqual([width <= 620 ? "12px" : "13px", "21px", "550", 44]);
          await dialog.getByRole("button", { name: "Close" }).click();
          await expect(paste).toBeFocused();
        }
        if (workspace === "receipts") {
          await expect(page.getByText("Amazon", { exact: true })).toBeVisible();
          const collection = page.getByTestId("receipt-collection-overview");
          const cards = collection.locator("[data-surface-tone]");
          await expect(cards).toHaveCount(2);
          expect(await cards.evaluateAll(elements => elements.map(element => element.getBoundingClientRect().height))).toEqual([256, 256]);
          const headings = await collection.getByRole("heading").evaluateAll(elements => elements.map(element => {
            const style = getComputedStyle(element);
            return [style.fontSize, style.lineHeight, style.fontWeight];
          }));
          expect(headings).toEqual([["14px", "22px", "600"], ["14px", "22px", "600"]]);
          const month = await page.getByTestId("receipt-month-group").first().getByRole("heading").evaluate(element => {
            const style = getComputedStyle(element);
            return [style.fontSize, style.lineHeight, style.fontWeight, style.letterSpacing];
          });
          expect(month).toEqual(["12px", "18px", "600", "normal"]);
        }
        expect(errors).toEqual([]);
        await page.screenshot({ path: testInfo.outputPath(`mail-${workspace}-${width}-${theme}.png`) });
      });
    }
  }
}

for (const width of [360, 393, 430, 768, 1024, 1440]) {
  for (const theme of ["light", "dark"] as const) {
    test(`Mail intro ${theme} at ${width}px hands off to setup`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: width >= 768 ? 1000 : 852 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.route("http://localhost/fixture.js", route => route.fulfill({ contentType: "application/javascript; charset=utf-8", body: script }));
      await page.route("http://localhost/mail-workspace", route => route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: `<!doctype html><html class="${theme}" data-workspace="intro"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`,
      }));
      await page.goto("http://localhost/mail-workspace");
      await awaitProductFont(page);
      await expect(page.getByRole("heading", { name: "Your mail, made useful." })).toBeVisible();
      const continueButton = page.getByRole("button", { name: "Continue" });
      expect((await continueButton.boundingBox())!.height).toBeGreaterThanOrEqual(50);
      await page.screenshot({ path: testInfo.outputPath(`mail-intro-${width}-${theme}.png`) });
      await continueButton.click();
      await expect(page.getByRole("button", { name: "Finish Mail setup" })).toBeVisible();
      await expect(page.locator('[data-capability-cinematic-body="gmail"]')).toBeFocused();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    });
  }
}

for (const width of [350, 351, 620, 621, 767]) {
  test(`Mail frame boundary at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 852 });
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await page.route("http://localhost/fixture.js", route => route.fulfill({ contentType: "application/javascript; charset=utf-8", body: script }));
    await page.route("http://localhost/mail-workspace", route => route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: `<!doctype html><html class="light" data-workspace="overview"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`,
    }));
    await page.goto("http://localhost/mail-workspace");
    await expect(page.getByRole("tablist", { name: "Gmail workspace" })).toBeVisible();
    const gutter = await page.locator(".app-page-shell").evaluate(element => parseFloat(getComputedStyle(element).paddingLeft));
    expect(gutter).toBe(width <= 350 ? 16 : width <= 620 ? 20 : 24);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  });
}

for (const width of [393, 1024]) {
  test(`Mail disconnected status ${width}px keeps the Connect action geometry`, async ({ page }) => {
    await page.setViewportSize({ width, height: 852 });
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await page.route("http://localhost/fixture.js", route => route.fulfill({ contentType: "application/javascript; charset=utf-8", body: script }));
    await page.route("http://localhost/mail-workspace", route => route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: `<!doctype html><html class="light" data-workspace="overview" data-connection="disconnected"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`,
    }));
    await page.goto("http://localhost/mail-workspace");
    const status = page.getByRole("tabpanel", { name: "Overview" }).getByTestId("mail-connection-status");
    await expect(status).toBeVisible();
    await awaitProductFont(page);
    const headingType = await status.locator("h2").evaluate(element => {
      const style = getComputedStyle(element);
      return [style.fontSize, style.lineHeight, style.fontWeight];
    });
    expect(headingType).toEqual(["14px", "22px", "600"]);
    const connect = status.getByRole("button", { name: "Connect Mail" });
    const geometry = await connect.evaluate(element => {
      const pill = element.querySelector<HTMLElement>("[data-slot=mail-action-pill]")!;
      const style = getComputedStyle(pill);
      return {
        outer: element.getBoundingClientRect().width,
        inner: pill.getBoundingClientRect().width,
        height: pill.getBoundingClientRect().height,
        border: style.borderTopWidth,
        radius: style.borderTopLeftRadius,
        background: style.backgroundColor,
      };
    });
    expect(geometry.outer).toBe(geometry.inner);
    expect(geometry.outer).toBeLessThanOrEqual(244);
    expect(geometry.height).toBe(44);
    expect(geometry.border).toBe("1px");
    expect(geometry.radius).toBe("999px");
    expect(geometry.background).not.toBe("rgba(0, 0, 0, 0)");
  });

  test(`Mail KYC request ${width}px keeps review and selection roles`, async ({ page }) => {
    await page.setViewportSize({ width, height: 852 });
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await page.route("http://localhost/fixture.js", route => route.fulfill({ contentType: "application/javascript; charset=utf-8", body: script }));
    await page.route("http://localhost/mail-workspace", route => route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: `<!doctype html><html class="light" data-workspace="kyc" data-queue="1"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`,
    }));
    await page.goto("http://localhost/mail-workspace");
    const review = page.getByRole("button", { name: "Review", exact: true });
    await expect(review).toBeVisible();
    await awaitProductFont(page);
    const rowName = await page.getByText("Information requested", { exact: true }).first().evaluate(element => {
      const style = getComputedStyle(element);
      return [style.fontSize, style.lineHeight, style.fontWeight];
    });
    expect(rowName).toEqual(["14px", "21px", "550"]);
    await review.click();
    const title = page.getByRole("heading", { name: "Review request" });
    await expect(title).toBeVisible();
    const titleType = await title.evaluate(element => {
      const style = getComputedStyle(element);
      return [style.fontSize, style.lineHeight, style.fontWeight];
    });
    expect(titleType).toEqual(["20px", "28px", "600"]);
    const choice = page.getByRole("button", { name: "Available: Postal code" });
    await expect(choice).toHaveAttribute("aria-pressed", "false");
    const before = await choice.locator("[data-slot=mail-action-pill]").evaluate(element => getComputedStyle(element).backgroundColor);
    await choice.click();
    const selected = page.getByRole("button", { name: "Selected: Postal code" });
    await expect(selected).toHaveAttribute("aria-pressed", "true");
    const after = await selected.locator("[data-slot=mail-action-pill]").evaluate(element => getComputedStyle(element).backgroundColor);
    expect(after).not.toBe(before);
    const openMail = page.getByRole("button", { name: "Open mail" });
    const utility = await openMail.evaluate(element => {
      const style = getComputedStyle(element);
      return [style.fontSize, style.lineHeight, style.fontWeight, element.getBoundingClientRect().height];
    });
    expect(utility).toEqual([width <= 620 ? "12px" : "13px", "21px", "550", 44]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  });

  test(`Mail saved receipt ${width}px opens the matching detail surface`, async ({ page }) => {
    await page.setViewportSize({ width, height: 852 });
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await page.route("http://localhost/fixture.js", route => route.fulfill({ contentType: "application/javascript; charset=utf-8", body: script }));
    await page.route("http://localhost/mail-workspace", route => route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: `<!doctype html><html class="light" data-workspace="receipts"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`,
    }));
    await page.goto("http://localhost/mail-workspace");
    const row = page.getByText("Amazon", { exact: true }).locator("xpath=ancestor::button[1]");
    await expect(row).toBeVisible();
    await row.click();
    const title = page.getByRole("heading", { name: "Amazon" });
    await expect(title).toBeVisible();
    await awaitProductFont(page);
    const titleType = await title.evaluate(element => {
      const style = getComputedStyle(element);
      return [style.fontSize, style.lineHeight, style.fontWeight];
    });
    expect(titleType).toEqual(["20px", "28px", "600"]);
    await expect(page.getByTestId("receipt-detail")).toBeVisible();
    await expect(page.getByText("Saved receipt details are available. Reconnect Mail or sync again to load the original email and source evidence.")).toBeVisible();
    const detail = page.getByTestId("receipt-detail");
    const valueType = await detail.locator("dd").first().evaluate(element => {
      const style = getComputedStyle(element);
      return [style.fontSize, style.lineHeight, style.fontWeight];
    });
    expect(valueType).toEqual(["14px", "21px", "550"]);
    await page.getByRole("button", { name: /^Close(?: detail panel)?$/ }).click();
    await expect(row).toBeFocused();
  });
}

for (const width of [360, 393, 430, 768, 1024, 1440]) {
  for (const theme of ["light", "dark"] as const) {
    test(`Mail setup body ${theme} at ${width}px keeps the full-page role`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: width >= 768 ? 1000 : 852 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.route("http://localhost/fixture.js", route => route.fulfill({ contentType: "application/javascript; charset=utf-8", body: script }));
      await page.route("http://localhost/mail-workspace", route => route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: `<!doctype html><html class="${theme}" data-workspace="setup"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`,
      }));
      await page.goto("http://localhost/mail-workspace");
      const finish = page.getByRole("button", { name: "Finish Mail setup" });
      await expect(finish).toBeVisible();
      await awaitProductFont(page);
      const title = await page.getByRole("heading", { level: 1, name: "Mail" }).evaluate(element => {
        const style = getComputedStyle(element);
        return [style.fontSize, style.lineHeight, style.fontWeight, style.fontFamily];
      });
      expect(title.slice(0, 3)).toEqual(["28px", "36px", "600"]);
      expect(title[3]).toContain("Plus Jakarta Sans");
      expect((await finish.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      await page.screenshot({ path: testInfo.outputPath(`mail-setup-${width}-${theme}.png`) });
    });
  }
}

test("Mail disconnected setup and prerequisite skeleton keep their own labels", async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 852 });
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await page.route("http://localhost/fixture.js", route => route.fulfill({ contentType: "application/javascript; charset=utf-8", body: script }));
  await page.route("http://localhost/mail-workspace", route => route.fulfill({
    contentType: "text/html; charset=utf-8",
    body: `<!doctype html><html class="light" data-workspace="setup" data-connection="disconnected"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`,
  }));
  await page.goto("http://localhost/mail-workspace");
  await expect(page.getByRole("button", { name: "Skip Mail setup" })).toBeVisible();
  await expect(page.getByText("You can connect Mail from setup whenever you are ready.")).toBeVisible();
  await page.route("http://localhost/mail-skeleton", route => route.fulfill({
    contentType: "text/html; charset=utf-8",
    body: `<!doctype html><html class="light" data-workspace="skeleton"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`,
  }));
  await page.goto("http://localhost/mail-skeleton");
  await expect(page.getByRole("heading", { level: 1, name: "Gmail" })).toBeVisible();
  const skeleton = page.getByLabel("Checking your Gmail status").first();
  await expect(skeleton).toHaveAttribute("aria-busy", "true");
  await page.route("http://localhost/mail-hidden-skeleton", route => route.fulfill({
    contentType: "text/html; charset=utf-8",
    body: `<!doctype html><html class="light" data-workspace="skeleton-hidden"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`,
  }));
  await page.goto("http://localhost/mail-hidden-skeleton");
  await expect(page.getByRole("heading", { level: 1, name: "Gmail" })).toHaveClass(/sr-only/);
  await expect(page.getByTestId("top-app-bar-breadcrumb-trail")).toHaveText("Mail");
});

test("Mail KYC cold check keeps its readable section heading", async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 852 });
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await page.route("http://localhost/fixture.js", route => route.fulfill({ contentType: "application/javascript; charset=utf-8", body: script }));
  await page.route("http://localhost/mail-workspace", route => route.fulfill({
    contentType: "text/html; charset=utf-8",
    body: `<!doctype html><html class="light" data-workspace="kyc" data-kyc-loading="1"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`,
  }));
  await page.goto("http://localhost/mail-workspace");
  const pending = page.getByLabel("Checking KYC setup");
  await expect(pending).toHaveAttribute("aria-busy", "true");
  const heading = await pending.getByText("KYC requests").evaluate(element => {
    const style = getComputedStyle(element);
    return [style.fontSize, style.lineHeight, style.fontWeight];
  });
  expect(heading).toEqual(["14px", "22px", "600"]);
});

for (const width of [393, 1024]) {
  test(`Mail KYC monitoring confirmation ${width}px preserves the shared decision`, async ({ page }) => {
    await page.setViewportSize({ width, height: 852 });
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await page.route("http://localhost/fixture.js", route => route.fulfill({ contentType: "application/javascript; charset=utf-8", body: script }));
    await page.route("http://localhost/mail-workspace", route => route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: `<!doctype html><html class="light" data-workspace="kyc" data-queue="1"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`,
    }));
    await page.goto("http://localhost/mail-workspace");
    const turnOff = page.getByRole("button", { name: "Turn off", exact: true });
    await expect(turnOff).toBeVisible();
    await turnOff.click();
    const alert = page.getByRole("alertdialog", { name: "Turn off monitoring?" });
    await expect(alert).toBeVisible();
    const title = await alert.getByRole("heading", { name: "Turn off monitoring?" }).evaluate(element => {
      const style = getComputedStyle(element);
      return [style.fontSize, style.lineHeight, style.fontWeight];
    });
    expect(title).toEqual(["20px", "28px", "600"]);
    await alert.getByRole("button", { name: "Keep monitoring on" }).click();
    await expect(alert).not.toBeVisible();
  });

  test(`Mail receipt updates ${width}px keeps the conditional dialog and focus`, async ({ page }) => {
    await page.setViewportSize({ width, height: 852 });
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await page.route("http://localhost/fixture.js", route => route.fulfill({ contentType: "application/javascript; charset=utf-8", body: script }));
    await page.route("http://localhost/mail-workspace", route => route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: `<!doctype html><html class="light" data-workspace="receipts" data-updates="disabled"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`,
    }));
    await page.goto("http://localhost/mail-workspace");
    const view = page.getByRole("button", { name: "View details" });
    await expect(view).toBeVisible();
    await view.click();
    const dialog = page.getByRole("dialog", { name: "Receipt updates" });
    await expect(dialog).toBeVisible();
    const title = await dialog.getByRole("heading", { name: "Receipt updates" }).evaluate(element => {
      const style = getComputedStyle(element);
      return [style.fontSize, style.lineHeight, style.fontWeight];
    });
    expect(title).toEqual(["20px", "28px", "600"]);
    await expect(dialog.getByText("New receipt updates aren’t supported by your current setup yet. You can still open saved receipts found on this device.")).toBeVisible();
    await dialog.getByRole("button", { name: "Got it" }).click();
    await expect(view).toBeFocused();
  });
}

for (const width of [360, 393, 430, 768, 1024, 1440]) {
  for (const theme of ["light", "dark"] as const) {
    test(`Mail OAuth return ${theme} at ${width}px preserves the recovery flow`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: width >= 768 ? 1000 : 852 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.route("http://localhost/fixture.js", route => route.fulfill({ contentType: "application/javascript; charset=utf-8", body: script }));
      await page.route("http://localhost/mail-callback", route => route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: `<!doctype html><html class="${theme}" data-workspace="callback"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`,
      }));
      await page.goto("http://localhost/mail-callback");
      const heading = page.getByRole("heading", { level: 1, name: "Mail connection needs attention" });
      await expect(heading).toBeVisible();
      await awaitProductFont(page);
      const title = await heading.evaluate(element => {
        const style = getComputedStyle(element);
        return [style.fontSize, style.lineHeight, style.fontWeight, style.fontFamily];
      });
      expect(title.slice(0, 3)).toEqual(["28px", "36px", "600"]);
      expect(title[3]).toContain("Plus Jakarta Sans");
      await expect(page.getByText("Google sign-in was cancelled.")).toBeVisible();
      const back = page.getByRole("button", { name: "Back to Mail" });
      await expect(back).toBeVisible();
      expect((await back.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      await page.screenshot({ path: testInfo.outputPath(`mail-oauth-return-${width}-${theme}.png`) });
    });
  }
}

for (const width of [393, 1024]) {
  test(`Mail OAuth return waiting ${width}px keeps a live status`, async ({ page }) => {
    await page.setViewportSize({ width, height: 852 });
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await page.route("http://localhost/fixture.js", route => route.fulfill({ contentType: "application/javascript; charset=utf-8", body: script }));
    await page.route("http://localhost/mail-callback", route => route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: `<!doctype html><html class="light" data-workspace="callback-loading"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`,
    }));
    await page.goto("http://localhost/mail-callback");
    const status = page.getByText("Connecting your Gmail…");
    await expect(status).toBeVisible();
    const role = await status.evaluate(element => {
      const style = getComputedStyle(element);
      return [style.fontSize, style.lineHeight, style.fontWeight];
    });
    expect(role).toEqual(["13px", "18px", "600"]);
  });
}

test("Cloud callback keeps its existing loading presentation", async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 852 });
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await page.route("http://localhost/fixture.js", route => route.fulfill({ contentType: "application/javascript; charset=utf-8", body: script }));
  await page.route("http://localhost/cloud-callback", route => route.fulfill({
    contentType: "text/html; charset=utf-8",
    body: `<!doctype html><html class="light" data-workspace="callback-cloud-loading"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`,
  }));
  await page.goto("http://localhost/cloud-callback");
  const cloudStatus = page.getByText("Setting up your cloud. This can take a few minutes…");
  await expect(cloudStatus).toBeVisible();
  expect(await cloudStatus.evaluate(element => getComputedStyle(element).fontSize)).toBe("14px");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(393);
});

for (const width of [360, 1024]) {
  for (const workspace of ["overview", "receipts"] as const) {
    test(`Mail ${workspace} ${width}px keeps long synthetic values within the frame`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: width >= 768 ? 1000 : 852 });
      await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
      await page.route("http://localhost/fixture.js", route => route.fulfill({ contentType: "application/javascript; charset=utf-8", body: script }));
      await page.route("http://localhost/mail-stress", route => route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: `<!doctype html><html class="light" data-workspace="${workspace}" data-stress="long"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`,
      }));
      await page.goto("http://localhost/mail-stress");
      await expect(page.getByText("Connected to alexander.morgan.with.a.very.long.name@international-research-and-services.example")).toBeVisible();
      if (workspace === "receipts") {
        const merchant = page.getByText("The Very Long International Merchant and Services Group Limited", { exact: true });
        await expect(merchant).toBeVisible();
        await merchant.scrollIntoViewIfNeeded();
        expect((await merchant.boundingBox())!.x + (await merchant.boundingBox())!.width).toBeLessThanOrEqual(width);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      await page.screenshot({ path: testInfo.outputPath(`mail-${workspace}-${width}-long.png`) });
    });
  }
}
