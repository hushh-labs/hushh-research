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

test("circle discovery advances every three seconds until a circle is explored", async ({
  page,
}) => {
  await page.setViewportSize({ width: 768, height: 900 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.setContent(
    `<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div></body></html>`,
  );
  await page.addScriptTag({ content: script });
  await awaitProductFont(page);

  const hero = page.getByTestId("connect-living-connections");
  const family = page.getByTestId("circle-starter-family");
  const finance = page.getByTestId("circle-starter-finance");
  const investor = page.getByTestId("circle-starter-investor");
  await expect(hero).toHaveAttribute("data-auto-tour", "running");
  await expect(family).toHaveAttribute("aria-pressed", "true");

  await page.waitForTimeout(3_100);
  await expect(finance).toHaveAttribute("aria-pressed", "true");
  await expect(hero).toHaveAttribute("data-auto-tour", "running");

  // Reading the card does not halt the guide. A direct movement within a circle
  // option is deliberate hover; merely mounting under a stationary pointer is not.
  await hero.getByRole("heading", { name: "Circles" }).hover();
  await page.waitForTimeout(3_100);
  await expect(investor).toHaveAttribute("aria-pressed", "true");
  await investor.hover();
  await expect(hero).toHaveAttribute("data-auto-tour", "stopped");
  await page.waitForTimeout(3_100);
  await expect(investor).toHaveAttribute("aria-pressed", "true");
});

for (const width of [320, 390, 1440]) {
  test(`existing circle shows two real member avatars beside the owner at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.setContent(
      `<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div></body></html>`,
    );
    await page.addScriptTag({ content: script });
    await awaitProductFont(page);
    await page.getByLabel("Fixture state").selectOption("populated");
    await page.getByRole("button", { name: "Explore Location Circle, already created" }).click();
    const hero = page.getByTestId("connect-living-connections");
    await expect(hero.getByTestId("circle-discovery-member-avatar")).toHaveCount(2);
    await expect(hero.getByTestId("circle-discovery-empty-slot")).toHaveCount(0);
    await expect(hero.getByTestId("circle-discovery-primary")).toHaveText("Open circle");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await hero.screenshot({ path: testInfo.outputPath("populated-location.png"), animations: "disabled" });
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
        const unitChannels = colour.startsWith("color(srgb ");
        const channels = colour
          .match(/[\d.]+/g)!
          .slice(0, 3)
          .map(Number)
          .map((channel) => unitChannels ? channel : channel / 255)
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
        expect(icon.background).toMatch(/^(rgb|color\(srgb)/);
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
    const checkNeutralSurfaces = async () => {
      const preview = page.getByTestId("circle-discovery-preview");
      const background = await preview.evaluate(
        (element) => getComputedStyle(element).backgroundColor,
      );
      for (const name of [
        "Family",
        "Finance",
        "Investor",
        "Business",
        "Location",
        "SMS",
      ]) {
        await page
          .getByRole("button", { name: new RegExp(`^Explore ${name} Circle`) })
          .click();
        expect(
          await preview.evaluate(
            (element) => getComputedStyle(element).backgroundColor,
          ),
        ).toBe(background);
        await expect(
          page.getByTestId("circle-discovery-orbit").locator(":scope > svg > circle"),
        ).toHaveAttribute("fill", "none");
      }
    };
    await checkNeutralSurfaces();
    const checkGeometry = async () => {
      const bounds = await hero.boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
      const nodes = page.locator('[data-testid^="circle-starter-"]');
      const nodeList = await nodes.all();
      const boxes = await Promise.all(nodeList.map((node) => node.boundingBox()));
      const owner = await page
        .getByTestId("circle-discovery-owner")
        .boundingBox();
      const overlaps = (
        a: NonNullable<typeof owner>,
        b: NonNullable<typeof owner>,
      ) =>
        Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > 1 &&
        Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > 1;
      const subtitle = await hero
        .getByText("Group people you trust. Choose what they can access.")
        .boundingBox();
      const customAction = await hero
        .getByRole("button", { name: "Create your own circle" })
        .boundingBox();
      expect(overlaps(subtitle!, customAction!)).toBe(false);
      for (let i = 0; i < boxes.length; i++) {
        const box = boxes[i]!;
        expect(box.width).toBeGreaterThanOrEqual(44);
        expect(box.height).toBeGreaterThanOrEqual(44);
        expect(box.x).toBeGreaterThanOrEqual(bounds!.x);
        expect(box.x + box.width).toBeLessThanOrEqual(
          bounds!.x + bounds!.width,
        );
        expect(overlaps(box, owner!), `${await nodeList[i]!.getAttribute("data-testid")} ${JSON.stringify(box)} versus owner ${JSON.stringify(owner)}`).toBe(false);
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
    if (width < 640) {
      const orbit = (await page
        .getByTestId("circle-discovery-orbit")
        .boundingBox())!;
      const expectedOrbitWidth = Math.min(width * 0.68, 288);
      expect(orbit.width, "mobile circle overview has useful visual scale").toBeGreaterThanOrEqual(expectedOrbitWidth - 0.1);
      const icon = (await page
        .locator("[data-circle-starter-icon]")
        .first()
        .boundingBox())!;
      expect(icon.width, "mobile circle icons stay legible").toBeGreaterThanOrEqual(48);
      const mobileType = await hero.evaluate((element) => {
        const heading = element.querySelector("h2")!;
        const supporting = element.querySelector("h2 + p")!;
        const primary = element.querySelector('[data-testid="circle-discovery-primary"]')!;
        return {
          heading: Number.parseFloat(getComputedStyle(heading).fontSize),
          supporting: Number.parseFloat(getComputedStyle(supporting).fontSize),
          primary: Number.parseFloat(getComputedStyle(primary).fontSize),
        };
      });
      expect(mobileType.heading).toBeGreaterThanOrEqual(20);
      expect(mobileType.supporting).toBeGreaterThanOrEqual(12);
      expect(mobileType.primary).toBeGreaterThanOrEqual(15);
    }
    const primaryAction = await page
      .getByTestId("circle-discovery-primary")
      .boundingBox();
    if (width < 640) {
      // Both short actions share a row, including compact phones, leaving
      // vertical room for the explanation above fixed app chrome.
      expect(primaryAction!.height).toBe(44);
      expect(primaryAction!.width).toBeGreaterThanOrEqual(width * 0.35);
      expect(primaryAction!.width).toBeLessThanOrEqual(width);
    }
    await page.getByRole("button", { name: "Explore Finance Circle" }).click();
    await expect(page.getByText(/help with your money and taxes/)).toBeVisible();
    await hero.screenshot({
      path: testInfo.outputPath("new-user-finance.png"),
      animations: "disabled",
    });
    await page.getByRole("button", { name: "Create a Circle — Finance Circle" }).click();
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
    if (width < 640)
      await expect(page.getByText("48 connected", { exact: true })).toBeVisible();
    await checkGeometry();
    await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "dark" });
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await checkNeutralSurfaces();
    await page.getByRole("button", { name: "Explore Investor Circle" }).click();
    await expect(page.getByText(/help you plan investments/)).toBeVisible();
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
  { width: 320, height: 667, safeTop: 20 },
  { width: 327, height: 742, safeTop: 20 },
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
    const topClearance = await page
      .locator('[data-app-shell-top-spacer="true"]')
      .evaluate((element) => {
        const sharedOffsetProbe = document.createElement("div");
        sharedOffsetProbe.style.cssText =
          "position:absolute;visibility:hidden;height:var(--app-top-content-offset)";
        element.parentElement!.append(sharedOffsetProbe);
        const result = {
          spacer: Number.parseFloat(getComputedStyle(element).height),
          sharedOffset: Number.parseFloat(
            getComputedStyle(sharedOffsetProbe).height,
          ),
        };
        sharedOffsetProbe.remove();
        return result;
      });
    expect(
      Math.round(topClearance.sharedOffset - topClearance.spacer),
      "Connect removes only its redundant mobile body gap",
    ).toBe(viewport.height <= 720 ? 64 : 52);
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
      await hero.getByTestId("circle-discovery-preview").evaluate(async (element) => {
        await Promise.all(element.getAnimations().map((animation) => animation.finished.catch(() => {})));
      });
      const preview = (await hero.getByTestId("circle-discovery-preview").boundingBox())!;
      const primary = (await hero.getByTestId("circle-discovery-primary").boundingBox())!;
      const secondary = (await hero.getByRole("button", { name: "Add connection" }).boundingBox())!;
      const ownerParts = await Promise.all([
        hero.locator("[data-circle-discovery-owner-avatar]"),
        hero.locator("[data-circle-discovery-owner-label]"),
        hero.locator("[data-circle-discovery-owner-status]"),
      ].map((part) => part.boundingBox()));
      const nodes = await hero.locator('[data-testid^="circle-starter-"]').all();
      for (const node of nodes) {
        const visibleParts = await Promise.all([
          node.locator("[data-circle-starter-icon]"),
          node.locator(":scope > span > span:last-child"),
        ].map((part) => part.boundingBox()));
        for (const box of visibleParts) {
          expect(box, `${await node.getAttribute("data-testid")} visible part exists`).not.toBeNull();
          for (const owner of ownerParts.filter((part) => part !== null)) {
            const overlapsOwner =
              Math.min(box!.x + box!.width, owner!.x + owner!.width) - Math.max(box!.x, owner!.x) > 1 &&
              Math.min(box!.y + box!.height, owner!.y + owner!.height) - Math.max(box!.y, owner!.y) > 1;
            expect(overlapsOwner, `${name}: ${await node.getAttribute("data-testid")} visible part ${JSON.stringify(box)} versus owner ${JSON.stringify(owner)}`).toBe(false);
          }
        }
        const label = visibleParts[1]!;
        expect(label.y + label.height, `${name}: ${await node.getAttribute("data-testid")} label stays above preview at ${preview.y}`).toBeLessThanOrEqual(preview.y - 2);
      }
      expect(preview.y + preview.height, `${name} explanation stays clear of actions`).toBeLessThanOrEqual(primary.y);
      expect(secondary.x - (primary.x + primary.width), "the two CTAs keep a visible gap").toBeGreaterThanOrEqual(4);
      for (const button of [hero.getByTestId("circle-discovery-primary"), hero.getByRole("button", { name: "Add connection" })]) {
        const content = (await button.locator(":scope > span").first().boundingBox())!;
        const bounds = (await button.boundingBox())!;
        expect(content.x, `${name} CTA label has left breathing room`).toBeGreaterThanOrEqual(bounds.x + 4);
        expect(content.x + content.width, `${name} CTA label has right breathing room`).toBeLessThanOrEqual(bounds.x + bounds.width - 4);
      }
      expect(
        Math.max(preview.y + preview.height, primary.y + primary.height, secondary.y + secondary.height),
        `${name} explanation and actions fit the first viewport`,
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
    const connected = (await hero.getByTestId("circle-discovery-primary").boundingBox())!;
    expect(
      connected.y + connected.height,
      "Populated connections keep the primary action above app chrome",
    ).toBeLessThanOrEqual(chrome.y);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByRole("button", { name: "Explore Investor Circle" }).click();
    expect(
      await hero.evaluate((el) => getComputedStyle(el).animationName),
    ).toBe("none");
  });
}
