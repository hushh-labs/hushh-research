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
const WIDTHS = [320, 375, 390, 430, 1280] as const;
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
    for (const token of match[1].split(/\s+/)) if (token) used.add(token);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "feed-person-layout-"));
  fs.writeFileSync(
    path.join(dir, "fixture.css"),
    stripAppFontFaces(compiler.build([...used])),
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
      '<main class="app-page-shell" data-app-density="compact" data-app-surface="one">' +
      markup +
      "</main></body></html>",
  );
  return pathToFileURL(path.join(dir, "fixture.html")).href;
}

test("compact person typography survives a portal outside the page shell", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 1000 });
  await page.goto(await buildFixture(false));
  await awaitProductFont(page);
  await page.evaluate(() => {
    const row = document.querySelector('[data-row-layout="person"]')!;
    document.body.appendChild(row);
    row.setAttribute("data-portal-person", "true");
  });
  const portalRow = page.locator('[data-portal-person="true"]');
  await expect(portalRow.locator('[data-slot="settings-row-title"]')).toHaveCSS(
    "font-size",
    "16px",
  );
  await expect(portalRow.locator(".ui-text-row-description-compact")).toHaveCSS(
    "font-size",
    "13px",
  );
});

for (const dark of [false, true]) {
  for (const width of WIDTHS) {
    test(
      "person rows remain aligned at " +
        width +
        "px " +
        (dark ? "dark" : "light"),
      async ({ page }, testInfo) => {
        await page.setViewportSize({ width, height: 1000 });
        await page.goto(await buildFixture(dark));
        await awaitProductFont(page);
        const rows = page.locator('[data-row-layout="person"]');
        // A missing selector used to silently pass this entire suite.
        await expect(rows).toHaveCount(6);
        for (const heading of await page
          .locator('[data-slot="settings-group-heading"]')
          .all()) {
          await expect(heading).toHaveCSS("font-size", "14px");
        }
        const measurements = await rows.evaluateAll((elements) =>
          elements.map((row) => {
            const box = row.getBoundingClientRect();
            const title = row.querySelector(
              '[data-slot="settings-row-title"]',
            )!;
            const avatar = row.querySelector(
              '[data-slot="avatar"],[data-slot="settings-row-icon"]',
            )!;
            const desc = row.querySelector(
              '[data-slot="feed-event-description"]',
            )!;
            const time = row.querySelector('[data-slot="feed-event-time"]')!;
            const t = title.getBoundingClientRect();
            const a = avatar.getBoundingClientRect();
            const d = desc.getBoundingClientRect();
            const stamp = time.getBoundingClientRect();
            const actions = [...row.querySelectorAll("button")].filter(
              (button) => !button.contains(title),
            );
            return {
              title: title.textContent,
              inset: t.left - box.left,
              avatarWidth: a.width,
              avatarHeight: a.height,
              separator: parseFloat(getComputedStyle(row, "::after").left),
              fontSize: parseFloat(getComputedStyle(title).fontSize),
              timeTop: stamp.top,
              descriptionBottom: d.bottom,
              timeWidth: stamp.width,
              height: box.height,
              overflow: [...row.querySelectorAll("*")].some((node) => {
                if ((node as HTMLElement).classList.contains("sr-only"))
                  return false;
                const bounds = node.getBoundingClientRect();
                return (
                  bounds.width > 0 &&
                  (bounds.left < box.left - 1 || bounds.right > box.right + 1)
                );
              }),
              actions: actions.map((button) => ({
                height: button.getBoundingClientRect().height,
                left: button.getBoundingClientRect().left - box.left,
              })),
            };
          }),
        );
        for (const row of measurements) {
          expect(row.inset, row.title ?? "").toBeCloseTo(68, 0);
          expect(row.separator).toBeCloseTo(68, 0);
          expect(row.avatarWidth).toBe(40);
          expect(row.avatarHeight).toBe(40);
          expect(row.fontSize).toBeLessThanOrEqual(16);
          expect(row.timeTop).toBeGreaterThanOrEqual(row.descriptionBottom);
          expect(row.timeWidth).toBeGreaterThan(40);
          expect(row.height).toBeGreaterThanOrEqual(72);
          expect(row.height).toBeLessThanOrEqual(220);
          expect(row.overflow, row.title ?? "").toBe(false);
          for (const action of row.actions)
            expect(action.height).toBeGreaterThanOrEqual(44);
          if (width < 640 && row.actions.length)
            expect(row.actions[0].left).toBeCloseTo(68, 0);
        }
        await expect(
          page.locator("button button, button a, a button"),
        ).toHaveCount(0);
        if (width === 390 || width === 1280) {
          await page.screenshot({
            path: testInfo.outputPath("feed-person-rows.png"),
            fullPage: true,
          });
        }
      },
    );
  }
}
