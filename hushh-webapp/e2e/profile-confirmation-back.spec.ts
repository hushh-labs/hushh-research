import { expect, test } from "@playwright/test";
import path from "node:path";

let script: string;
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
  script = outputs.flatMap(output => "output" in output ? output.output : [])
    .filter(chunk => chunk.type === "chunk").map(chunk => chunk.code).join("\n");
});

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("https://profile-back.test/**", route => route.fulfill({
    contentType: "text/html",
    body: `<html><head><title>Profile Back contract</title><style>
      body { margin: 24px; font-family: sans-serif; }
      button { padding: 12px; margin: 6px; }
      [data-slot=sheet-content] { position: fixed; inset: 0 0 0 auto; width: 430px; background: white; z-index: 712; }
      [data-slot=alert-dialog-content] { position: fixed; top: 35%; left: 30%; width: 350px; padding: 24px; background: white; z-index: 900; }
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
    await page.getByRole("button", { name: `${action} confirmation`, exact: true }).click();
    await page.goBack();
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    await expect(page).toHaveURL(accountUrl);
    await expect(page.getByRole("heading", { name: "Account", exact: true })).toBeVisible();
    expect(await page.evaluate(() => ({ state: history.state, length: history.length }))).toEqual(before);
    await expect(page.getByTestId("mutation-count")).toHaveText("0");
    await page.goBack();
    await expect(page.getByRole("heading", { name: "Profile", exact: true })).toBeVisible();
    await page.goForward();
    await expect(page).toHaveURL(accountUrl);
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
  });
}

test("dismissal preserves existing Forward history and Cancel/Escape add no entries", async ({ page }) => {
  await page.getByRole("button", { name: "Open Details", exact: true }).click();
  const detailsUrl = page.url();
  await page.goBack();
  await expect(page.getByRole("heading", { name: "Account", exact: true })).toBeVisible();
  const length = await page.evaluate(() => history.length);
  for (const dismissal of ["Cancel", "Escape", "Back"] as const) {
    await page.getByRole("button", { name: "Reset confirmation", exact: true }).click();
    if (dismissal === "Cancel") await page.getByRole("button", { name: "Cancel", exact: true }).click();
    else if (dismissal === "Escape") await page.keyboard.press("Escape");
    else await page.goBack();
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
  await page.goBack();
  await expect(page).toHaveURL(accountUrl);
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await expect(page.getByTestId("mutation-count")).toHaveText("0");
});
