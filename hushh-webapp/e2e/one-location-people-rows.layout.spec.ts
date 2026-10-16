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

async function buildFixture(
  dark: boolean,
  extraCandidates: string[] = [],
  markupOverride?: string,
): Promise<string> {
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
  const markup = markupOverride ?? fs.readFileSync(
    path.join(root, "e2e/fixtures/one-location-people-rows.html"),
    "utf8",
  );
  const used = new Set<string>(extraCandidates);
  for (const match of markup.matchAll(/class="([^"]*)"/g)) {
    const className = match[1].replace(/&amp;/g, "&").replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&#x27;/g, "'").replace(/&quot;/g, '"');
    for (const token of className.split(/\s+/)) if (token) used.add(token);
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

test.describe("Contact scroll with the page-enter observer", () => {
  let script: string;
  let candidates: string[];

  test.beforeAll(async () => {
    const root = process.cwd();
    const { build } = await import("vite");
    const { Scanner } = await import("@tailwindcss/oxide");
    const scanner = new Scanner({});
    const used = new Set<string>();
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "contact-scroll-"));
    await build({
      configFile: false,
      logLevel: "error",
      plugins: [{
        name: "fixture-css-candidates",
        transform(source, id) {
          if (!id.includes("node_modules") && /\.[tj]sx?$/.test(id)) {
            for (const candidate of scanner.scanFiles([
              { content: source, extension: "tsx" },
            ])) used.add(candidate);
          }
        },
      }],
      oxc: { jsx: { runtime: "automatic" } },
      resolve: { alias: { "@": root } },
      define: {
        "process.env.NODE_ENV": JSON.stringify("production"),
        "process.env": "{}",
      },
      build: {
        outDir,
        lib: {
          entry: path.join(root, "e2e/fixtures/one-location-contact-scroll.tsx"),
          name: "Fixture",
          formats: ["iife"],
          fileName: () => "fixture.js",
        },
      },
    });
    script = fs.readFileSync(path.join(outDir, "fixture.js"), "utf8");
    candidates = [...used];
  });

  for (const presentation of ["grouped", "cards"] as const) {
    for (const [width, dark] of [[390, false], [390, true], [1280, false]] as const) {
      test(`${presentation} roster survives selection and scroll reversal at ${width}px ${dark ? "dark" : "light"}`, async ({ page }, testInfo) => {
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.emulateMedia({ reducedMotion: "no-preference" });
        await page.setViewportSize({ width, height: 844 });
        await page.goto(await buildFixture(dark, candidates, '<div id="root"></div>'));
        await page.evaluate((value) => {
          document.body.dataset.presentation = value;
          document.documentElement.classList.add("native-ios");
        }, presentation);
        await page.addScriptTag({ content: script });
        await awaitProductFont(page);
        await page.getByRole("button", { name: "Ask for location" }).click();
        await expect(page.getByRole("heading", { name: "Ask for location" })).toBeVisible();
        const list = page.getByTestId("scroll-roster");
        // Prove the real page animation initialized before mounting more rows.
        await expect(page.locator("#root > div")).toHaveAttribute("data-gsap-auto-fade-ready", "1");
        await page.getByRole("button", { name: "Add Person 000", exact: true }).click();
        await page.getByRole("button", { name: "Add Person 001", exact: true }).click();
        await expect(page.getByTestId("selected-count")).toHaveText("2 selected");

        const geometry = async (scrollTop: number) => list.evaluate(async (element, top) => {
          element.scrollTop = top;
          const frames = [];
          // Measure while the mutation-triggered tween runs and after it clears
          // props. Healthy counts/heights alone cannot detect lost row offsets.
          for (let frame = 0; frame < 32; frame++) {
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
            const rows = [...element.querySelectorAll<HTMLElement>("[data-index]")];
            const boxes = rows.map((row) => row.getBoundingClientRect());
            frames.push({
              overlaps: boxes.slice(1).filter((box, index) => box.top < boxes[index].bottom - 1).length,
              missingOffsets: rows.filter((row) => Number(row.dataset.index) > 0 && !row.style.transform).length,
              firstIndex: Number(rows[0]?.dataset.index),
              count: rows.length,
            });
          }
          return frames;
        }, scrollTop);
        const down = await geometry(1900);
        const up = await geometry(0);
        await page.screenshot({ path: testInfo.outputPath("selected-after-scroll.png") });
        expect(down.at(-1)!.firstIndex).toBeGreaterThan(10);
        expect(up.at(-1)!.firstIndex).toBe(0);
        for (const frame of [...down, ...up]) {
          expect(frame.count).toBeGreaterThan(0);
          expect(frame.count).toBeLessThan(30);
          expect(frame.overlaps).toBe(0);
          expect(frame.missingOffsets).toBe(0);
        }
        await expect(page.getByRole("button", { name: "Remove Person 000", exact: true })).toBeVisible();
        await expect(page.getByRole("button", { name: "Remove Person 001", exact: true })).toBeVisible();
        await expect(page.getByTestId("selected-count")).toHaveText("2 selected");

        const firstRow = list.locator('[data-index="0"]');
        const collapsedHeight = await firstRow.evaluate((row) => row.getBoundingClientRect().height);
        await page.getByRole("button", { name: "Toggle details" }).click();
        await expect.poll(() => firstRow.evaluate((row) => row.getBoundingClientRect().height)).toBeGreaterThan(collapsedHeight);
        await page.getByRole("button", { name: "Toggle details" }).click();
        await expect.poll(() => firstRow.evaluate((row) => row.getBoundingClientRect().height)).toBe(collapsedHeight);
        await page.getByRole("textbox", { name: "Search people" }).fill("Person 11");
        await expect(page.getByRole("button", { name: "Add Person 119", exact: true })).toBeVisible();
        await page.getByRole("textbox", { name: "Search people" }).fill("");
        await expect(page.getByRole("button", { name: "Remove Person 000", exact: true })).toBeVisible();
        await page.getByRole("button", { name: "Remove Person 000", exact: true }).click();
        await expect(page.getByTestId("selected-count")).toHaveText("1 selected");
        expect(errors).toEqual([]);
      });
    }
  }
});

for (const dark of [false, true]) {
  for (const width of WIDTHS) {
    test(`Invite and live-link actions at ${width}px ${dark ? "dark" : "light"}`, async ({ page }, testInfo) => {
      const markup = fs.readFileSync(path.join(process.cwd(), "e2e/fixtures/one-location-invite-actions.html"), "utf8");
      await page.setViewportSize({ width, height: 900 });
      await page.goto(await buildFixture(dark, [], markup));
      await awaitProductFont(page);
      const draft = page.locator("[data-invite-draft]");
      await expect(draft.getByRole("heading", { name: "Invite before sharing", exact: true })).toBeVisible();
      await expect(draft.getByText("No location shared")).toHaveCount(0);
      await expect(draft.getByText("They approve first.")).toHaveCount(0);
      await expect(page.locator("[data-invite-created]").getByRole("button", { name: "Done", exact: true })).toHaveCount(0);
      const geometry = await page.evaluate(() => {
        const draft = document.querySelector("[data-invite-draft]")!;
        const trailing = draft.querySelector("[data-slot=settings-row-trailing]")!.getBoundingClientRect();
        const choices = [...draft.querySelectorAll('[role="radio"]')].map((el) => el.getBoundingClientRect());
        const groups = ["circle-invite-actions", "public-link-actions"].map((id) => {
          const group = document.querySelector(`[data-testid="${id}"]`)!;
          const buttons = [...group.querySelectorAll("button")].map((el) => {
            const box = el.getBoundingClientRect();
            return { left: box.left, right: box.right, top: box.top, height: box.height, width: box.width, fits: el.scrollWidth <= el.clientWidth + 1 };
          });
          return { buttons, width: group.getBoundingClientRect().width };
        });
        return { trailingRight: trailing.right, choicesRight: choices.at(-1)!.right, choiceTops: choices.map((box) => box.top), groups, overflow: document.documentElement.scrollWidth > innerWidth + 1 };
      });
      expect(geometry.overflow).toBe(false);
      expect(Math.abs(geometry.choicesRight - geometry.trailingRight)).toBeLessThanOrEqual(4);
      expect(Math.abs(geometry.choiceTops[0] - geometry.choiceTops[1])).toBeLessThanOrEqual(1);
      for (const group of geometry.groups) {
        expect(group.buttons).toHaveLength(2);
        expect(Math.abs(group.buttons[0].top - group.buttons[1].top)).toBeLessThanOrEqual(1);
        expect(group.buttons[0].right).toBeLessThan(group.buttons[1].left);
        for (const button of group.buttons) {
          expect(button.height).toBeGreaterThanOrEqual(44);
          expect(button.fits).toBe(true);
        }
      }
      expect(geometry.groups[1].buttons[0].width).toBeLessThanOrEqual(110);
      expect(geometry.groups[1].buttons[1].width).toBeLessThanOrEqual(145);
      if (width === 320 || width === 1280) await page.screenshot({ path: testInfo.outputPath("invite-link-actions.png"), fullPage: true });
    });

    test(`People actions and icon-free Circles summary at ${width}px ${dark ? "dark" : "light"}`, async ({
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
          const name = person.querySelector('p[title]') as HTMLElement;
          return {
            nameHeight: name.getBoundingClientRect().height,
            nameWhiteSpace: getComputedStyle(name).whiteSpace,
            nameOverflow: getComputedStyle(name).textOverflow,
            height: rowBox.height,
            rowRight: rowBox.right,
            paddingRight: parseFloat(getComputedStyle(row).paddingRight),
            personRight: personBox.right,
            personTop: personBox.top,
            personBottom: personBox.bottom,
            personCenter: (personBox.top + personBox.bottom) / 2,
            actions: actions.map((action) => {
              const box = action.getBoundingClientRect();
              const surface = action.querySelector<HTMLElement>(
                "[data-location-action-surface]",
              )!;
              const surfaceBox = surface.getBoundingClientRect();
              return {
                label: action.textContent?.trim(),
                background: getComputedStyle(surface).backgroundColor,
                surfaceColor: getComputedStyle(surface).color,
                targetBackground: getComputedStyle(action).backgroundColor,
                color: getComputedStyle(action).color,
                weight: getComputedStyle(action).fontWeight,
                shadow: getComputedStyle(action).boxShadow,
                radius: getComputedStyle(surface).borderRadius,
                cornerShape: getComputedStyle(surface).getPropertyValue("corner-shape"),
                surfaceHeight: surfaceBox.height,
                surfaceTopInset: surfaceBox.top - box.top,
                surfaceBottomInset: box.bottom - surfaceBox.bottom,
                surfaceWidth: surfaceBox.width,
                surfaceFits: surface.scrollWidth <= surface.clientWidth + 1,
                iconCount: action.querySelectorAll("svg").length,
                left: box.left,
                right: box.right,
                top: box.top,
                bottom: box.bottom,
                height: box.height,
                width: box.width,
                center: (box.top + box.bottom) / 2,
                inside:
                  box.left >= rowBox.left - 1 && box.right <= rowBox.right + 1,
              };
            }),
          };
        });
        const circlesSummary = document.querySelector<HTMLElement>(
          '[data-testid="one-location-circles-summary"]',
        )!;
        return {
          rows: rowMeasurements,
          identityStackCount: circlesSummary.querySelectorAll(
            "[data-circle-identity-stack]",
          ).length,
          overflowCount: circlesSummary.querySelectorAll(
            "[data-circle-overflow-count]",
          ).length,
          summaryIconCount: circlesSummary.querySelectorAll("svg").length,
          pageOverflow:
            document.documentElement.scrollWidth > window.innerWidth + 1,
        };
      });

      expect(measurements.rows).toHaveLength(3);
      expect(measurements.pageOverflow).toBe(false);
      expect(measurements.identityStackCount).toBe(0);
      expect(measurements.overflowCount).toBe(0);
      expect(measurements.summaryIconCount).toBe(1);
      for (const row of measurements.rows) {
        expect(row.nameHeight).toBeLessThanOrEqual(22);
        expect(row.nameWhiteSpace).toBe("nowrap");
        expect(row.nameOverflow).toBe("ellipsis");
        expect(row.actions).toHaveLength(2);
        expect(row.actions.map((action) => action.label)).toEqual(["Share", "Ask"]);
        expect(row.actions[0].background).toBe("rgb(0, 122, 255)");
        expect(row.actions[0].color).toBe("rgb(255, 255, 255)");
        expect(row.actions[1].background).toBe("rgb(242, 242, 247)");
        expect(row.actions[1].color).toBe("rgb(0, 122, 255)");
        expect(row.actions[1].left - row.actions[0].right).toBe(8);
        expect(row.actions[0].height).toBe(row.actions[1].height);
        expect(row.height).toBeLessThanOrEqual(90);
        expect(Math.abs(row.actions.at(-1)!.right - (row.rowRight - row.paddingRight))).toBeLessThanOrEqual(1);
        for (const action of row.actions) {
          expect(action.weight).toBe("500");
          expect(parseFloat(action.radius)).toBeGreaterThanOrEqual(action.surfaceHeight / 2);
          expect(action.cornerShape).not.toContain("superellipse");
          expect(action.targetBackground).toBe("rgba(0, 0, 0, 0)");
          expect(action.surfaceHeight).toBe(40);
          expect(action.surfaceTopInset).toBe(2);
          expect(action.surfaceBottomInset).toBe(2);
          expect(action.surfaceWidth).toBe(action.width);
          expect(action.surfaceFits).toBe(true);
          expect(action.surfaceColor).toBe(action.color);
          expect(action.iconCount).toBe(0);
          // Tailwind's empty focus-ring layers serialize as transparent
          // shadows even when the control has no visible shadow.
          const shadowColors = action.shadow.match(/rgba?\([^)]+\)/g) ?? [];
          expect(action.shadow === "none" || shadowColors.every(
            (color) => color === "rgba(0, 0, 0, 0)",
          )).toBe(true);
          expect(action.height).toBe(44);
          expect(action.width).toBeGreaterThanOrEqual(44);
          expect(action.width).toBeLessThanOrEqual(
            width < 640 ? (action.label === "Share" ? 70 : 56) : 104,
          );
          expect(action.inside).toBe(true);
          expect(action.left).toBeGreaterThanOrEqual(row.personRight);
          expect(Math.abs(action.center - row.personCenter)).toBeLessThanOrEqual(6);
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
    const joinMarkup = fs.readFileSync(
      path.join(process.cwd(), "e2e/fixtures/circle-join-code.html"),
      "utf8",
    );
    await page.goto(await buildFixture(false, [], joinMarkup));
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
