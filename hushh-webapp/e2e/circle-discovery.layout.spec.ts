import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  awaitProductFont,
  productFontStyle,
  stripAppFontFaces,
} from "./fixtures/product-font";

// The shipped React card and product CSS, with fixture data and action callbacks.
// Service/mutation behavior is covered by circle-discovery.test.tsx.
let css: string;
let script: string;
let headerClass: string;
test.beforeAll(async () => {
  const root = process.cwd();
  const { build } = await import("vite");
  const { Scanner } = await import("@tailwindcss/oxide");
  const scanner = new Scanner({});
  const candidates = new Set<string>();
  headerClass = JSON.parse(
    fs
      .readFileSync(path.join(root, "app/connect/page-client.tsx"), "utf8")
      .match(/const CONNECT_STICKY_HEADER_CLASSNAME =\s*("[^"]+");/)![1],
  );
  for (const candidate of headerClass.split(" ")) candidates.add(candidate);
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "circle-discovery-"));
  await build({
    configFile: false,
    logLevel: "error",
    plugins: [
      {
        name: "fixture-css-candidates",
        transform(source, id) {
          if (!id.includes("node_modules") && /\.[tj]sx?$/.test(id)) {
            for (const candidate of scanner.scanFiles([
              { content: source, extension: "tsx" },
            ]))
              candidates.add(candidate);
          }
        },
      },
    ],
    oxc: { jsx: { runtime: "automatic" } },
    resolve: { alias: { "@": root } },
    define: {
      "process.env.NODE_ENV": JSON.stringify("production"),
      "process.env": "{}",
    },
    build: {
      outDir,
      emptyOutDir: false,
      lib: {
        entry: path.join(root, "e2e/fixtures/circle-discovery.tsx"),
        name: "Fixture",
        formats: ["iife"],
        fileName: () => "fixture.js",
      },
    },
  });
  script = fs.readFileSync(path.join(outDir, "fixture.js"), "utf8");
  const { compile } = await import("tailwindcss");
  const compiler = await compile(
    fs
      .readFileSync(path.join(root, "app/globals.css"), "utf8")
      .replace(/^@source\s+[^;]+;\s*$/gm, ""),
    {
      base: path.join(root, "app"),
      loadStylesheet: async (id, base) => {
        const file =
          id === "tailwindcss"
            ? path.join(root, "node_modules/tailwindcss/index.css")
            : id === "tw-animate-css"
              ? path.join(
                  root,
                  "node_modules/tw-animate-css/dist/tw-animate.css",
                )
              : path.resolve(base, id);
        return {
          path: file,
          base: path.dirname(file),
          content: fs.readFileSync(file, "utf8"),
        };
      },
    },
  );
  css =
    stripAppFontFaces(compiler.build([...candidates])) +
    productFontStyle() +
    fs
      .readdirSync(outDir)
      .filter((name) => name.endsWith(".css"))
      .map((name) => fs.readFileSync(path.join(outDir, name), "utf8"))
      .join("\n");
});

for (const width of [320, 393, 768, 1440]) {
  test(`circle list actions and touch targets at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.setContent(`<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div></body></html>`);
    await page.addScriptTag({ content: script });
    await awaitProductFont(page);
    const hero = page.getByTestId("connect-living-connections");
    await expect(hero.getByRole("button", { name: /^Setup .* circle$/ })).toHaveCount(6);
    await hero.getByRole("button", { name: "Setup Finance circle" }).click();
    await expect(hero.getByRole("button", { name: "Open Finance circle" })).toBeVisible();
    await hero.getByRole("button", { name: "Open Finance circle" }).click();
    await expect(page.getByRole("status")).toHaveText("Open finance");
    await hero.getByRole("button", { name: "Create your own circle" }).click();
    await expect(page.getByRole("status")).toHaveText("Custom circle");
    await page.getByLabel("Fixture state").selectOption("populated");
    await expect(hero.getByTestId("circle-starter-location")).toContainText("3 members");
    await expect(hero.getByRole("button", { name: "Open Location circle" })).toBeVisible();
    const targets = await hero.getByRole("button").evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().height));
    expect(targets.every((height) => height >= 44)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.getByLabel("Fixture state").selectOption("loading");
    await expect(hero.getByRole("button", { name: "Setup Family circle" })).toBeDisabled();
    await page.getByLabel("Fixture state").selectOption("error");
    await hero.getByRole("button", { name: "Retry circles" }).click();
    await expect(page.getByRole("status")).toHaveText("Retry circles");
  });
}

for (const width of [320, 390, 768, 1440]) {
  test(`new circle placeholders stay responsive and give way to members at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.setContent(
      `<html data-circle-detail="true"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div></body></html>`,
    );
    await page.addScriptTag({ content: script });
    await awaitProductFont(page);
    const panel = page.getByTestId("connect-living-circle-detail");
    const spots = panel.locator("[data-circle-empty-spot]:visible");
    const orbit = page.getByTestId("people-orbit");
    const checkGeometry = async () => {
      const bounds = (await orbit.boundingBox())!;
      const card = (await panel.boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(card.x);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(card.x + card.width);
      const nodes = await orbit
        .locator(
          "[data-circle-empty-spot]:visible, [data-orbit-center]:visible, [title]:visible, [data-testid='people-orbit-overflow']:visible",
        )
        .all();
      const boxes = await Promise.all(nodes.map((node) => node.boundingBox()));
      for (let i = 0; i < boxes.length; i++) {
        const box = boxes[i]!;
        expect(box.x).toBeGreaterThanOrEqual(bounds.x);
        expect(box.x + box.width).toBeLessThanOrEqual(bounds.x + bounds.width);
        expect(box.y).toBeGreaterThanOrEqual(bounds.y);
        expect(box.y + box.height).toBeLessThanOrEqual(
          bounds.y + bounds.height,
        );
        for (const other of boxes.slice(i + 1)) {
          expect(
            box.x + box.width <= other!.x ||
              other!.x + other!.width <= box.x ||
              box.y + box.height <= other!.y ||
              other!.y + other!.height <= box.y,
          ).toBe(true);
        }
      }
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    };
    await expect(spots).toHaveCount(3);
    await expect(panel.getByText("Your circle starts with you")).toBeVisible();
    await checkGeometry();
    await panel.screenshot({
      path: testInfo.outputPath("new-circle-spots.png"),
      animations: "disabled",
    });
    await panel
      .getByRole("button", { name: "Add Asha Rao to Investor Circle" })
      .click();
    await expect(spots).toHaveCount(2);
    await expect(panel.getByText("2 people in this circle")).toBeVisible();
    await expect(orbit.locator('[title="Asha Rao"]:visible')).toBeVisible();
    await checkGeometry();
    const state = page.getByLabel("Circle detail fixture state");
    await state.selectOption("populated");
    await expect(spots).toHaveCount(0);
    await expect(
      orbit.locator("[data-testid='people-orbit-overflow']:visible"),
    // The owner remains in the center, so the radial overflow counts only
    // members outside that center position.
    ).toHaveText(width < 640 ? "+8" : "+6");
    await checkGeometry();
    await state.selectOption("no-connections");
    await expect(spots).toHaveCount(3);
    await expect(
      panel.getByRole("link", { name: "Find people" }),
    ).toBeVisible();
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await checkGeometry();
    await panel.screenshot({
      path: testInfo.outputPath("empty-circle-dark.png"),
      animations: "disabled",
    });
    for (const value of ["loading", "error", "full", "read-only"]) {
      await state.selectOption(value);
      await expect(spots).toHaveCount(value === "loading" ? 3 : 0);
      await checkGeometry();
    }
  });
}
