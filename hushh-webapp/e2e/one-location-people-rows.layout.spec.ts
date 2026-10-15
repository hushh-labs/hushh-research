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

async function buildFixture(dark: boolean, kind: "people" | "join" = "people"): Promise<string> {
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
    path.join(root, kind === "people" ? "e2e/fixtures/one-location-people-rows.html" : "e2e/fixtures/circle-join-code.html"),
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
    test(`People actions and Circles badge at ${width}px ${dark ? "dark" : "light"}`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(await buildFixture(dark));
      await awaitProductFont(page);

      const measurements = await page.evaluate(() => {
        const rows = [
          ...document.querySelectorAll<HTMLElement>("[data-people-rows] > div"),
        ];
        const rowMeasurements = rows.map((row) => {
          const person = row.querySelector<HTMLButtonElement>(
            'button[aria-label^="Open Location actions"]',
          )!;
          const actions = [
            ...row.querySelectorAll<HTMLButtonElement>('[role="group"] button'),
          ];
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
              const icon = action.querySelector<SVGElement>("svg");
              const iconBox = icon?.getBoundingClientRect();
              return {
                label: action.textContent?.trim(),
                background: getComputedStyle(action).backgroundColor,
                color: getComputedStyle(action).color,
                weight: getComputedStyle(action).fontWeight,
                shadow: getComputedStyle(action).boxShadow,
                radius: getComputedStyle(action).borderRadius,
                left: box.left,
                right: box.right,
                top: box.top,
                bottom: box.bottom,
                height: box.height,
                center: (box.top + box.bottom) / 2,
                inside:
                  box.left >= rowBox.left - 1 && box.right <= rowBox.right + 1,
                iconVisible: Boolean(
                  iconBox &&
                  iconBox.width > 0 &&
                  iconBox.height > 0 &&
                  getComputedStyle(icon!).display !== "none",
                ),
              };
            }),
          };
        });
        const identities = [
          ...document.querySelectorAll<HTMLElement>(
            "[data-circle-identity-stack] > span",
          ),
        ].map((item) => item.getBoundingClientRect());
        const counter = document
          .querySelector<HTMLElement>("[data-circle-overflow-count]")!
          .getBoundingClientRect();
        const counterElement = document.querySelector<HTMLElement>(
          "[data-circle-overflow-count]",
        )!;
        const counterStyle = getComputedStyle(counterElement);
        return {
          rows: rowMeasurements,
          identityCount: identities.length,
          circlesOverlap: identities[1].left < identities[0].right,
          counterGap: counter.left - identities[1].right,
          counterLabel: counterElement.textContent?.trim(),
          counterBackground: counterStyle.backgroundColor,
          counterBorderRadius: counterStyle.borderRadius,
          counterPaddingInline: `${counterStyle.paddingLeft} ${counterStyle.paddingRight}`,
          pageOverflow:
            document.documentElement.scrollWidth > window.innerWidth + 1,
        };
      });

      expect(measurements.rows).toHaveLength(3);
      expect(measurements.pageOverflow).toBe(false);
      expect(measurements.identityCount).toBe(2);
      expect(measurements.circlesOverlap).toBe(true);
      expect(measurements.counterLabel).toBe("+2");
      expect(measurements.counterBackground).toBe("rgba(0, 0, 0, 0)");
      expect(measurements.counterBorderRadius).toBe("0px");
      expect(measurements.counterPaddingInline).toBe("0px 0px");
      expect(measurements.counterGap).toBeGreaterThanOrEqual(7);
      for (const row of measurements.rows) {
        expect(row.actions).toHaveLength(2);
        expect(row.actions.map((action) => action.label)).toEqual(["Share", "Ask"]);
        expect(row.actions[0].background).toBe("rgb(0, 113, 227)");
        expect(row.actions[0].color).toBe("rgb(255, 255, 255)");
        expect(row.actions[1].background).toBe("rgb(242, 242, 247)");
        expect(row.actions[1].color).toBe("rgb(28, 28, 30)");
        expect(row.actions[1].left - row.actions[0].right).toBe(8);
        expect(row.actions[0].height).toBe(row.actions[1].height);
        expect(row.height).toBeLessThanOrEqual(width < 400 ? 140 : 90);
        for (const action of row.actions) {
          expect(action.weight).toBe("500");
          expect(action.radius).toBe("16px");
          // Tailwind's empty focus-ring layers serialize as transparent
          // shadows even when the control has no visible shadow.
          const shadowColors = action.shadow.match(/rgba?\([^)]+\)/g) ?? [];
          expect(action.shadow === "none" || shadowColors.every(
            (color) => color === "rgba(0, 0, 0, 0)",
          )).toBe(true);
          expect(action.height).toBeGreaterThanOrEqual(44);
          expect(action.inside).toBe(true);
          expect(action.iconVisible).toBe(true);
          if (width >= 400) {
            expect(action.left).toBeGreaterThanOrEqual(row.personRight);
            expect(
              Math.abs(action.center - row.personCenter),
            ).toBeLessThanOrEqual(6);
          } else {
            expect(action.top).toBeGreaterThanOrEqual(row.personBottom);
          }
        }
      }
      await expect(
        page.locator("button button, a button, button a"),
      ).toHaveCount(0);
      if (width === 320 || width === 390 || width === 1280) {
        await page.screenshot({
          path: testInfo.outputPath("people-rows.png"),
          fullPage: true,
        });
      }
    });
  }
}

for (const width of [320, 390, 768, 1280]) {
  test(`Join Circle groups and matching actions fit at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(await buildFixture(false, "join"));
    await awaitProductFont(page);
    const fields = page.getByRole("textbox");
    await expect(fields).toHaveCount(3);
    for (const [index, value] of ["RF58", "DG8G", "W544"].entries()) {
      await expect(fields.nth(index)).toHaveValue(value);
      await expect(fields.nth(index)).toHaveCSS("height", "56px");
      await expect(fields.nth(index)).toHaveCSS("border-radius", "12px");
    }
    const review = page.getByRole("button", { name: "Review Circle" });
    const paste = page.getByRole("button", { name: "Paste from clipboard" });
    await expect(review).toHaveCSS("background-color", "rgb(0, 136, 255)");
    await expect(review).toHaveCSS("color", "rgb(255, 255, 255)");
    await expect(paste).toHaveCSS("background-color", "rgb(240, 240, 240)");
    await expect(paste).toHaveCSS("color", "rgb(0, 136, 255)");
    for (const button of [review, paste]) {
      await expect(button).toHaveCSS("height", "52px");
      await expect(button).toHaveCSS("border-radius", "20px");
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    const boxes = await fields.evaluateAll((inputs) => inputs.map((input) => {
      const box = input.getBoundingClientRect();
      return { width: box.width, top: box.top, scroll: input.scrollWidth, client: input.clientWidth };
    }));
    expect(new Set(boxes.map((box) => box.top)).size).toBe(1);
    for (const box of boxes) {
      expect(box.width).toBeGreaterThanOrEqual(64);
      expect(box.scroll).toBeLessThanOrEqual(box.client + 1);
    }
    const evidence = process.env.CIRCLE_JOIN_EVIDENCE_DIR;
    if (evidence && (width === 390 || width === 1280)) {
      fs.mkdirSync(evidence, { recursive: true });
      await page.screenshot({ path: path.join(evidence, `join-circle-${width}-${testInfo.project.name}.png`), fullPage: true });
    }
  });
}
