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

for (const width of [320, 390, 640, 768, 1440]) {
  test(`circle discovery fits and stays actionable at ${width}px`, async ({
    page,
  }, testInfo) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewportSize({ width, height: 900 });
    await page.setContent(
      `<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div></body></html>`,
    );
    await page.addScriptTag({ content: script });
    await awaitProductFont(page);
    const hero = page.getByTestId("connect-living-connections");
    await expect(hero).toBeVisible();
    const checkIconColours = async () => {
      const colours = await page
        .locator("[data-circle-starter-icon]")
        .evaluateAll((icons) =>
          icons.map((icon) => {
            const style = getComputedStyle(icon);
            return {
              id: icon.getAttribute("data-circle-starter-icon"),
              foreground: style.color,
              background: style.backgroundColor,
            };
          }),
        );
      expect(colours).toHaveLength(6);
      expect(new Set(colours.map((icon) => icon.background)).size).toBe(6);
      const luminance = (colour: string) => {
        const channels = colour
          .match(/[\d.]+/g)!
          .slice(0, 3)
          .map(Number)
          .map((channel) => channel / 255)
          .map((channel) =>
            channel <= 0.04045
              ? channel / 12.92
              : ((channel + 0.055) / 1.055) ** 2.4,
          );
        return (
          channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
        );
      };
      for (const icon of colours) {
        expect(icon.background).toMatch(/^rgb\(/);
        expect(icon.foreground).toMatch(/^rgb\(/);
        const foreground = luminance(icon.foreground);
        const background = luminance(icon.background);
        expect(
          (Math.max(foreground, background) + 0.05) /
            (Math.min(foreground, background) + 0.05),
          `${icon.id} icon contrast`,
          // Graphical icons need 3:1; the SMS glyph is small text (4.5:1).
        ).toBeGreaterThanOrEqual(icon.id === "sms" ? 4.5 : 3);
      }
      return colours.map((icon) => icon.background);
    };
    const lightColours = await checkIconColours();
    const checkGeometry = async () => {
      const bounds = await hero.boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
      const nodes = page.locator('[data-testid^="circle-starter-"]');
      const boxes = await Promise.all(
        (await nodes.all()).map((node) => node.boundingBox()),
      );
      const owner = await page
        .getByTestId("circle-discovery-owner")
        .boundingBox();
      const overlaps = (
        a: NonNullable<typeof owner>,
        b: NonNullable<typeof owner>,
      ) =>
        Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > 1 &&
        Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > 1;
      for (let i = 0; i < boxes.length; i++) {
        const box = boxes[i]!;
        expect(box.width).toBeGreaterThanOrEqual(44);
        expect(box.height).toBeGreaterThanOrEqual(44);
        expect(box.x).toBeGreaterThanOrEqual(bounds!.x);
        expect(box.x + box.width).toBeLessThanOrEqual(
          bounds!.x + bounds!.width,
        );
        expect(overlaps(box, owner!)).toBe(false);
        for (let j = i + 1; j < boxes.length; j++)
          expect(overlaps(box, boxes[j]!)).toBe(false);
      }
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
    };
    await checkGeometry();
    await page.getByRole("button", { name: "Explore Finance Circle" }).click();
    await expect(page.getByText(/your CA, financial advisor/)).toBeVisible();
    await hero.screenshot({
      path: testInfo.outputPath("new-user-finance.png"),
      animations: "disabled",
    });
    await page.getByRole("button", { name: "Create Finance Circle" }).click();
    await expect(
      page.getByRole("button", {
        name: "Explore Finance Circle, already created",
      }),
    ).toBeVisible();
    if (width >= 640)
      await expect(
        page.getByText("Created · ready for your people"),
      ).toBeVisible();
    await page.getByRole("button", { name: "Open circle" }).click();
    await expect(page.getByRole("status")).toHaveText("Open finance");
    await page.getByRole("button", { name: "Add connection" }).click();
    await expect(page.getByRole("status")).toHaveText("Find people");
    await page.getByLabel("Fixture state").selectOption("connected");
    const remaining = page.getByText("+45", { exact: true });
    if (width >= 360) await expect(remaining).toBeVisible();
    else await expect(remaining).toBeHidden();
    if (width < 640) {
      const count = await page
        .getByText("48 connected", { exact: true })
        .boundingBox();
      const add = await page
        .getByRole("button", { name: "Add connection" })
        .boundingBox();
      expect(count!.x + count!.width).toBeLessThanOrEqual(add!.x);
    }
    await checkGeometry();
    await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "dark" });
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await page.getByRole("button", { name: "Explore Investor Circle" }).click();
    await expect(page.getByText(/investor and RIA/)).toBeVisible();
    expect(await checkIconColours()).not.toEqual(lightColours);
    await checkGeometry();
    await hero.screenshot({
      path: testInfo.outputPath("connected-dark-investor.png"),
      animations: "disabled",
    });
    await page.getByLabel("Fixture state").selectOption("error");
    await page.getByRole("button", { name: "Retry circles" }).click();
    await expect(page.getByRole("status")).toHaveText("Retry circles");
    expect(errors).toEqual([]);
  });
}

for (const viewport of [
  { width: 375, height: 812, safeTop: 44 },
  { width: 390, height: 844, safeTop: 47 },
  { width: 430, height: 932, safeTop: 59 },
]) {
  test(`intro fits above mobile chrome without scrolling at ${viewport.width}x${viewport.height}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    await page.setContent(
      `<html data-shell="true" data-safe-top="${viewport.safeTop}px" data-header-class="${headerClass}"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div></body></html>`,
    );
    await page.addScriptTag({ content: script });
    await awaitProductFont(page);
    const hero = page.getByTestId("connect-living-connections");
    await expect(hero).toBeVisible();
    // Wait for the product reveal, not an arbitrary sleep. Only the initial mount staggers.
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            document
              .getAnimations()
              .filter((animation) => animation.playState === "running").length,
        ),
      )
      .toBe(0);
    const chrome = (await page.locator("[data-bottom-chrome]").boundingBox())!;
    for (const name of [
      "Family",
      "Finance",
      "Investor",
      "Business",
      "Location",
      "SMS",
    ]) {
      await page
        .getByRole("button", { name: `Explore ${name} Circle` })
        .click();
      const bounds = (await hero.boundingBox())!;
      expect(
        bounds.y + bounds.height,
        `${name} fits the first viewport`,
      ).toBeLessThanOrEqual(chrome.y);
    }
    expect(
      await page
        .locator("[data-app-scroll-root]")
        .evaluate((el) => el.scrollTop),
    ).toBe(0);
    await page.screenshot({
      path: testInfo.outputPath("full-mobile-intro.png"),
      animations: "disabled",
    });
    await page
      .getByLabel("Fixture state")
      .selectOption("connected", { force: true });
    const connected = (await hero.boundingBox())!;
    expect(
      connected.y + connected.height,
      "Populated connections and Trusted circle fit too",
    ).toBeLessThanOrEqual(chrome.y);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByRole("button", { name: "Explore Investor Circle" }).click();
    expect(
      await hero.evaluate((el) => getComputedStyle(el).animationName),
    ).toBe("none");
  });
}
