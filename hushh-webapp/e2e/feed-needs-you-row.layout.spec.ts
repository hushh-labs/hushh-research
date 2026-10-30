import { expect, test } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  awaitProductFont,
  productFontStyle,
  stripAppFontFaces,
} from "./fixtures/product-font";

// Captured from the current real components by verify:feed, never handwritten DOM.
const WIDTHS = [320, 375, 390, 393, 430, 1280] as const;
async function buildFixture(dark: boolean): Promise<string> {
  const root = process.cwd();
  const { compile } = await import(
    path.join(root, "node_modules/tailwindcss/dist/lib.mjs")
  );
  const globals = fs
    .readFileSync(path.join(root, "app/globals.css"), "utf8")
    .replace(/^@source\s+[^;]+;\s*$/gm, "");
  const compiler = await compile(globals, {
    base: path.join(root, "app"),
    onDependency: () => {},
    loadStylesheet: async (id: string, base: string) => {
      const file =
        id === "tailwindcss"
          ? path.join(root, "node_modules/tailwindcss/index.css")
          : id === "tw-animate-css"
            ? path.join(root, "node_modules/tw-animate-css/dist/tw-animate.css")
            : path.resolve(base, id);
      return {
        path: file,
        base: path.dirname(file),
        content: fs.readFileSync(file, "utf8"),
      };
    },
  });
  const markup = fs.readFileSync(
    path.join(root, "e2e/fixtures/feed-needs-you-rows.html"),
    "utf8",
  );
  const used = new Set<string>();
  for (const match of markup.matchAll(/class="([^"]*)"/g)) {
    // React escapes arbitrary selector utilities in static HTML. Tailwind
    // needs the original token, for example `[&>a]:min-h-[52px]`, otherwise
    // the browser fixture silently falls back to SettingsRow's 48px minimum.
    const classNames = match[1]
      .replaceAll("&amp;", "&")
      .replaceAll("&gt;", ">")
      .replaceAll("&lt;", "<")
      .replaceAll("&#x27;", "'")
      .replaceAll("&quot;", '"');
    for (const token of classNames.split(/\s+/)) if (token) used.add(token);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "feed-person-layout-"));
  fs.writeFileSync(
    path.join(dir, "fixture.css"),
    stripAppFontFaces((await import("lightningcss")).transform({ code: Buffer.from(compiler.build([...used])), minify: true }).code.toString()),
  );
  fs.writeFileSync(
    path.join(dir, "fixture.html"),
    '<!doctype html><html class="' +
      (dark ? "dark" : "") +
      '"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
      '<link rel="stylesheet" href="fixture.css"><style>' +
      productFontStyle() +
      "body{margin:0;background:var(--background);color:var(--foreground)}" +
      "main{max-width:1040px;margin:auto;padding:16px}</style></head><body>" +
      '<main class="app-page-shell" data-app-density="compact" data-app-surface="one" data-profile-type-scale="page">' +
      markup +
      "</main></body></html>",
  );
  return pathToFileURL(path.join(dir, "fixture.html")).href;
}

test("explicit Feed typography survives outside the page shell", async ({ page }) => {
  await page.goto(await buildFixture(false));
  await awaitProductFont(page);
  await page.evaluate(() => {
    const row = document.querySelector('[data-testid="feed-row"]')!;
    row.setAttribute("data-profile-type-scale", "feed");
    document.body.appendChild(row);
    row.setAttribute("data-portal-feed", "true");
  });
  await expect(page.locator('[data-portal-feed] [data-slot="settings-row-title"]')).toHaveCSS("font-size", "13px");
  await expect(page.locator('[data-portal-feed] [data-slot="feed-event-description"]')).toHaveCSS("font-size", "12px");
});

for (const dark of [false, true]) {
  for (const width of WIDTHS) {
    test(`Feed uses one text line and right-side times at ${width}px ${dark ? "dark" : "light"}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 1100 });
      await page.goto(await buildFixture(dark));
      await awaitProductFont(page);
      const rows = page.locator('[data-row-layout="settings"][data-testid^="feed-actionable-"]:not([data-testid^="feed-actionable-sms-emergency:"]), [data-row-layout="settings"][data-testid^="feed-drive-progress-"], [data-testid="feed-row"]');
      await expect(rows).toHaveCount(16);
      for (const heading of await page.locator('[data-slot="settings-group-heading"]').all()) {
        await expect(heading).toHaveCSS("font-size", "10px");
      }
      const measurements = await rows.evaluateAll(elements => elements.map(row => {
        const box = row.getBoundingClientRect();
        const copy = row.querySelector('[data-slot="feed-inline-copy"]')!;
        const title = copy.querySelector('[data-profile-role="name"]')!;
        const description = copy.querySelector('[data-slot="feed-event-description"]')!;
        const time = row.querySelector('[data-slot="feed-event-time"]')!;
        const t = title.getBoundingClientRect();
        const d = description.getBoundingClientRect();
        const stamp = time?.getBoundingClientRect();
        const buttons = [...row.querySelectorAll('button')].filter(node => node.getBoundingClientRect().width > 0 && !node.contains(copy));
        return {
          label: title.textContent,
          titleSize: getComputedStyle(title).fontSize,
          descriptionSize: getComputedStyle(description).fontSize,
          timeSize: time ? getComputedStyle(time).fontSize : null,
          titleWidth: t.width,
          titleHeight: t.height,
          descriptionHeight: d.height,
          textCenterDelta: Math.abs((t.top + t.height / 2) - (d.top + d.height / 2)),
          timeCenterDelta: stamp ? Math.abs((box.top + box.height / 2) - (stamp.top + stamp.height / 2)) : null,
          timeWidth: stamp?.width,
          timeLeft: stamp?.left,
          copyRight: copy.getBoundingClientRect().right,
          height: box.height,
          overflow: [...row.querySelectorAll('*')].some(node => {
            if (node.classList.contains('sr-only')) return false;
            const rect = node.getBoundingClientRect();
            // Text can extend inside an ellipsis box; the visible box itself cannot.
            return rect.width > 0 && (rect.left < box.left - 1 || rect.right > box.right + 1);
          }),
          actions: buttons.map(node => ({ height: node.getBoundingClientRect().height, top: node.getBoundingClientRect().top })),
        };
      }));
      for (const row of measurements) {
        expect.soft(row.titleSize, row.label ?? "").toBe("13px");
        expect.soft(row.descriptionSize).toBe("12px");
        if (row.timeSize) expect.soft(row.timeSize).toBe("12px");
        expect.soft(row.titleHeight).toBeLessThanOrEqual(17);
        expect.soft(row.descriptionHeight).toBeLessThanOrEqual(17);
        expect.soft(row.textCenterDelta).toBeLessThanOrEqual(1);
        if (row.timeCenterDelta != null) {
          expect.soft(row.timeCenterDelta).toBeLessThanOrEqual(1);
          expect.soft(row.timeWidth).toBeGreaterThan(40);
          expect.soft(row.timeLeft).toBeGreaterThanOrEqual(row.copyRight - 1);
        }
        expect.soft(row.height).toBeGreaterThanOrEqual(52);
        expect.soft(row.height).toBeLessThanOrEqual(60);
        expect.soft(row.titleWidth, row.label ?? "").toBeGreaterThan(20);
        expect.soft(row.overflow, row.label ?? "").toBe(false);
        for (const action of row.actions) expect.soft(action.height).toBeGreaterThanOrEqual(44);
      }
      const consent = page.locator('[data-testid^="feed-actionable-consent:"]');
      if (width < 640) {
        await expect(consent.getByRole("button", { name: "Review", exact: true })).toBeVisible();
        await expect(consent.getByRole("button", { name: "Allow", exact: true })).toBeHidden();
      } else {
        await expect(consent.getByRole("button", { name: "Allow", exact: true })).toBeVisible();
        await expect(consent.getByRole("button", { name: "Review", exact: true })).toBeHidden();
      }
      await expect(page.locator('[data-testid="feed-actionable-android-connection"]').getByRole("button", { name: /^Report/ })).toBeVisible();
      await expect(page.locator("button button, button a, a button")).toHaveCount(0);
      const sms = page.getByTestId("feed-sms-alert-group");
      await expect(sms.locator("summary")).toContainText("3 recent SMS alerts · 1 active");
      await expect(sms.locator("summary time")).toBeVisible();
      await sms.locator("summary").focus();
      await page.keyboard.press("Enter");
      await expect(sms).toHaveAttribute("open", "");
      await expect(sms.getByRole("link", { name: /Emergency SMS · Active/ })).toBeVisible();
      const sentTimes = sms.locator('[data-testid^="feed-actionable-sms-emergency:"] time');
      await expect(sentTimes).toHaveCount(3);
      for (const stamp of await sentTimes.all()) {
        await expect(stamp).toBeVisible();
        const box = await stamp.boundingBox();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(width);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      if (width === 393 || width === 1280) {
        await page.screenshot({ path: testInfo.outputPath("feed-rows.png"), fullPage: true });
      }
    });
  }
}
