import { expect, test } from "@playwright/test";
import path from "node:path";

let script: string;
let css: string;
// Confirmation Back can cancel traversal entirely: invoke the browser's Back
// action without waiting for the navigation that must not happen.
test.beforeAll(async () => {
  const { build } = await import("vite");
  const root = process.cwd();
  const result = await build({
    configFile: false,
    logLevel: "error",
    oxc: { jsx: { runtime: "automatic" } },
    define: { "process.env.NODE_ENV": JSON.stringify("production"), "process.env": "{}" },
    resolve: { alias: { "@": root } },
    build: {
      write: false,
      lib: { entry: path.join(root, "e2e/fixtures/profile-confirmation-back.tsx"), formats: ["iife"], name: "ProfileBackFixture" },
    },
  });
  const outputs = Array.isArray(result) ? result : [result];
  const chunks = outputs.flatMap(output => "output" in output ? output.output : []);
  script = chunks.filter(chunk => chunk.type === "chunk").map(chunk => chunk.code).join("\n");
  css = chunks.filter(chunk => chunk.type === "asset" && chunk.fileName.endsWith(".css"))
    .map(chunk => String(chunk.source)).join("\n");
});

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("https://profile-back.test/**", route => route.fulfill({
    contentType: "text/html; charset=utf-8",
    body: `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Profile Back contract</title><style>
      * { box-sizing: border-box; }
      body { margin: 24px; font-family: sans-serif; }
      button { padding: 12px; margin: 6px; }
      [data-slot=sheet-content] { position: fixed; inset: 0 0 0 auto; width: min(430px, 100vw); background: white; z-index: 712; }
      [data-slot=alert-dialog-content] { position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 350px; padding: 24px; background: white; z-index: 900; }
      [data-display-name-actions] { display: flex; justify-content: flex-end; gap: 8px; }
      #display-name { display: block; width: 100%; }
      ${css}
    </style></head><body><div id="root"></div><script>${script}</script></body></html>`,
  }));
  await page.goto("https://profile-back.test/one");
  await page.getByRole("button", { name: "Open Profile", exact: true }).click();
  await page.getByRole("button", { name: "Open Account", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Account", exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

for (const action of ["Reset", "Delete"] as const) {
  test(`${action}: browser Back dismisses confirmation before moving Profile`, async ({ page }) => {
    const accountUrl = page.url();
    const before = await page.evaluate(() => ({ state: history.state, length: history.length }));
    const supportsEarlyBack = await page.evaluate(() => {
      const win = window as Window & { navigation?: unknown; profileBackReveals?: string[] };
      win.profileBackReveals = [];
      window.addEventListener("popstate", () => win.profileBackReveals!.push(location.search), true);
      return Boolean(win.navigation) && /(?:Chrome|Chromium)\//.test(navigator.userAgent);
    });
    await page.getByRole("button", { name: `${action} confirmation`, exact: true }).click();
    await page.evaluate(() => history.back());
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    await expect(page).toHaveURL(accountUrl);
    await expect(page.getByRole("heading", { name: "Account", exact: true })).toBeVisible();
    expect(await page.evaluate(() => ({ state: history.state, length: history.length }))).toEqual(before);
    if (supportsEarlyBack) {
      expect(await page.evaluate(() => (window as Window & { profileBackReveals?: string[] }).profileBackReveals)).toEqual([]);
    }
    await expect(page.getByTestId("mutation-count")).toHaveText("0");
    await expect(page.getByTestId("sheet-dismissal-count")).toHaveText("0");
    await page.evaluate(() => history.back());
    await expect(page.getByRole("heading", { name: "Profile", exact: true })).toBeVisible();
    await page.goForward();
    await expect(page).toHaveURL(accountUrl);
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
  });
}

test("dismissal preserves existing Forward history and Cancel/Escape add no entries", async ({ page }) => {
  await page.getByRole("button", { name: "Open Details", exact: true }).click();
  const detailsUrl = page.url();
  await page.evaluate(() => history.back());
  await expect(page.getByRole("heading", { name: "Account", exact: true })).toBeVisible();
  const length = await page.evaluate(() => history.length);
  for (const dismissal of ["Cancel", "Escape", "Back"] as const) {
    await page.getByRole("button", { name: "Reset confirmation", exact: true }).click();
    if (dismissal === "Cancel") await page.getByRole("button", { name: "Cancel", exact: true }).click();
    else if (dismissal === "Escape") await page.keyboard.press("Escape");
    else await page.evaluate(() => history.back());
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Account", exact: true })).toBeVisible();
    expect(await page.evaluate(() => history.length)).toBe(length);
  }
  await page.goForward();
  await expect(page).toHaveURL(detailsUrl);
  await expect(page.getByRole("heading", { name: "Details", exact: true })).toBeVisible();
  await expect(page.getByTestId("mutation-count")).toHaveText("0");
});

test("a confirmation can refuse Back without moving the pane below it", async ({ page }) => {
  const accountUrl = page.url();
  await page.getByRole("button", { name: "Refusing confirmation", exact: true }).click();
  await page.evaluate(() => history.back());
  await expect(page).toHaveURL(accountUrl);
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await expect(page.getByTestId("mutation-count")).toHaveText("0");
});

test("Forward with a confirmation open updates the entry consumed by the next Back", async ({ page }) => {
  await page.getByRole("button", { name: "Open Details", exact: true }).click();
  const detailsUrl = page.url();
  await page.evaluate(() => history.back());
  await expect(page.getByRole("heading", { name: "Account", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Reset confirmation", exact: true }).click();
  await page.goForward();
  await expect(page).toHaveURL(detailsUrl);
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await page.evaluate(() => history.back());
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(page).toHaveURL(detailsUrl);
  await expect(page.getByRole("heading", { name: "Details", exact: true })).toBeVisible();
  await page.evaluate(() => history.back());
  await expect(page.getByRole("heading", { name: "Account", exact: true })).toBeVisible();
  await expect(page.getByTestId("mutation-count")).toHaveText("0");
});

test("synthetic navigation cannot dismiss a confirmation", async ({ page }) => {
  await page.getByRole("button", { name: "Reset confirmation", exact: true }).click();
  const accountUrl = page.url();
  await page.evaluate(() => {
    const navigation = (window as Window & { navigation?: EventTarget }).navigation;
    const event = new Event("navigate", { cancelable: true });
    Object.assign(event, { navigationType: "traverse", destination: { index: 0, sameDocument: true } });
    navigation?.dispatchEvent(event);
  });
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await expect(page).toHaveURL(accountUrl);
  await expect(page.getByTestId("mutation-count")).toHaveText("0");
});

test("older engines restore the confirmation's entry after the router commits first", async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(window, "navigation", { value: undefined, configurable: true }));
  await page.goto("https://profile-back.test/one?router-first=1");
  await page.getByRole("button", { name: "Open Profile", exact: true }).click();
  await page.getByRole("button", { name: "Open Account", exact: true }).click();
  const accountUrl = page.url();
  const before = await page.evaluate(() => ({ state: history.state, length: history.length }));
  await page.getByRole("button", { name: "Reset confirmation", exact: true }).click();
  await page.evaluate(() => history.back());
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(page).toHaveURL(accountUrl);
  await expect(page.getByRole("heading", { name: "Account", exact: true })).toBeVisible();
  expect(await page.evaluate(() => ({ state: history.state, length: history.length }))).toEqual(before);
  await expect(page.getByTestId("mutation-count")).toHaveText("0");
});

for (const action of ["Reset", "Delete"] as const) {
  test(`${action}: Profile owner history settles before the shell router rerenders`, async ({ page }) => {
    await page.goto("https://profile-back.test/one?lagged-shell=1");
    await page.getByRole("button", { name: "Open Profile", exact: true }).click();
    await page.getByRole("button", { name: "Open Account", exact: true }).click();
    await page.getByRole("button", { name: "Commit stale shell query", exact: true }).click();
    const accountUrl = page.url();
    const before = await page.evaluate(() => ({ state: history.state, length: history.length }));
    await page.getByRole("button", { name: `${action} confirmation`, exact: true }).click();
    await page.evaluate(() => history.back());
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    await expect(page).toHaveURL(accountUrl);
    await expect(page.getByRole("heading", { name: "Account", exact: true })).toBeVisible();
    expect(await page.evaluate(() => ({ state: history.state, length: history.length }))).toEqual(before);
    await page.evaluate(() => history.back());
    await expect(page.getByRole("heading", { name: "Profile", exact: true })).toBeVisible();
    await expect(page.getByTestId("mutation-count")).toHaveText("0");
  });
}

for (const action of ["Reset", "Delete"] as const) {
  test(`${action}: router commits the revealed Profile query before the Back listener`, async ({ page }) => {
    await page.goto("https://profile-back.test/one?router-first=1");
    await page.getByRole("button", { name: "Open Profile", exact: true }).click();
    await page.getByRole("button", { name: "Open Account", exact: true }).click();
    const accountUrl = page.url();
    const before = await page.evaluate(() => ({ state: history.state, length: history.length }));
    await page.getByRole("button", { name: `${action} confirmation`, exact: true }).click();
    await page.evaluate(() => history.back());
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    await expect(page).toHaveURL(accountUrl);
    await expect(page.getByRole("heading", { name: "Account", exact: true })).toBeVisible();
    expect(await page.evaluate(() => ({ state: history.state, length: history.length }))).toEqual(before);
    await page.evaluate(() => history.back());
    await expect(page.getByRole("heading", { name: "Profile", exact: true })).toBeVisible();
    await expect(page.getByTestId("mutation-count")).toHaveText("0");
  });
}

for (const width of [1280, 320]) {
  test(`account actions share a compact 36px height at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.getByRole("button", { name: "Edit display name", exact: true }).click();
    const editorActions = page.locator("[data-display-name-actions] > button");
    const heights = await editorActions.evaluateAll(buttons => buttons.map(button => button.getBoundingClientRect().height));
    expect(heights).toEqual([36, 36]);
    expect((await page.getByLabel("Display name", { exact: true }).boundingBox())!.height).toBe(44);
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    for (const action of ["Reset", "Delete"]) {
      await page.getByRole("button", { name: `${action} confirmation`, exact: true }).click();
      const buttons = page.getByRole("alertdialog").locator("[data-slot=alert-dialog-footer] > button");
      expect(await buttons.evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().height))).toEqual([36, 36]);
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
    }
    await expect(page.getByTestId("mutation-count")).toHaveText("0");
  });
}
