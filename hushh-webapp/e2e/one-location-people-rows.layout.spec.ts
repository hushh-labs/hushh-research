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

const WIDTHS = [320, 360, 390, 430, 768, 1280] as const;

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
    path.join(root, "e2e/fixtures/one-location-people-rows.html"),
    "utf8",
  );
  const used = new Set<string>();
  for (const match of markup.matchAll(/class="([^"]*)"/g)) {
    for (const token of match[1].split(/\s+/)) if (token) used.add(token);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "location-people-layout-"));
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
      "body{margin:0;background:var(--background);color:var(--foreground)}</style></head><body>" +
      '<main class="app-page-shell" data-app-density="compact" data-app-surface="one">' +
      markup +
      "</main></body></html>",
  );
  return pathToFileURL(path.join(dir, "fixture.html")).href;
}

for (const dark of [false, true]) {
  for (const width of WIDTHS) {
    test(`People actions and Circles badge at ${width}px ${dark ? "dark" : "light"}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(await buildFixture(dark));
      await awaitProductFont(page);

      const measurements = await page.evaluate(() => {
        const rows = [...document.querySelectorAll<HTMLElement>("[data-people-rows] > div")];
        const rowMeasurements = rows.map((row) => {
          const person = row.querySelector<HTMLButtonElement>('button[aria-label^="Open Location actions"]')!;
          const actions = [...row.querySelectorAll<HTMLButtonElement>('[role="group"] button')];
          const rowBox = row.getBoundingClientRect();
          const personBox = person.getBoundingClientRect();
          return {
            height: rowBox.height,
            personRight: personBox.right,
            personTop: personBox.top,
            personBottom: personBox.bottom,
            personCenter: (personBox.top + personBox.bottom) / 2,
            actions: actions.map((action) => {
              const box = action.getBoundingClientRect();
              return {
                left: box.left,
                right: box.right,
                top: box.top,
                bottom: box.bottom,
                height: box.height,
                center: (box.top + box.bottom) / 2,
                inside: box.left >= rowBox.left - 1 && box.right <= rowBox.right + 1,
              };
            }),
          };
        });
        const identities = [...document.querySelectorAll<HTMLElement>("[data-circle-identity-stack] > span")].map((item) => item.getBoundingClientRect());
        const counter = document.querySelector<HTMLElement>("[data-circle-overflow-count]")!.getBoundingClientRect();
        return {
          rows: rowMeasurements,
          identityCount: identities.length,
          circlesOverlap: identities[1].left < identities[0].right,
          counterGap: counter.left - identities[1].right,
          counterLabel: document.querySelector("[data-circle-overflow-count]")!.textContent?.trim(),
          pageOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
        };
      });

      expect(measurements.rows).toHaveLength(3);
      expect(measurements.pageOverflow).toBe(false);
      expect(measurements.identityCount).toBe(2);
      expect(measurements.circlesOverlap).toBe(true);
      expect(measurements.counterLabel).toBe("+2");
      expect(measurements.counterGap).toBeGreaterThanOrEqual(7);
      for (const row of measurements.rows) {
        expect(row.actions).toHaveLength(2);
        expect(row.height).toBeLessThanOrEqual(width < 360 ? 140 : 90);
        for (const action of row.actions) {
          expect(action.height).toBeGreaterThanOrEqual(44);
          expect(action.inside).toBe(true);
          if (width >= 360) {
            expect(action.left).toBeGreaterThanOrEqual(row.personRight);
            expect(Math.abs(action.center - row.personCenter)).toBeLessThanOrEqual(6);
          } else {
            expect(action.top).toBeGreaterThanOrEqual(row.personBottom);
          }
        }
      }
      await expect(page.locator("button button, a button, button a")).toHaveCount(0);
      if (width === 320 || width === 390 || width === 1280) {
        await page.screenshot({ path: testInfo.outputPath("people-rows.png"), fullPage: true });
      }
    });
  }
}
