import { expect, test } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  CONNECT_CIRCLE_GRID_CLASSNAME,
  CONNECT_CIRCLE_TILE_CLASSNAME,
  CONNECT_HERO_ACTIONS_CLASSNAME,
  CONNECT_HERO_CLASSNAME,
  CONNECT_HERO_ORBIT_CLASSNAME,
} from "../components/connect/connect-living-layout";
import { buttonVariants } from "../lib/ui/button-variants";
import { getVariantStyles } from "../lib/morphy-ux/utils";

const widths = [320, 360, 390, 430, 768, 1440] as const;
const primaryButtonClass = `${buttonVariants({ variant: "ghost", size: "standard" })} ${getVariantStyles("blue", "fill")} gap-2`;
const secondaryButtonClass = `${buttonVariants({ variant: "ghost", size: "standard" })} ${getVariantStyles("none", "fade")} gap-2`;
const fixtureClasses = [
  CONNECT_HERO_CLASSNAME,
  CONNECT_HERO_ORBIT_CLASSNAME,
  CONNECT_HERO_ACTIONS_CLASSNAME,
  CONNECT_CIRCLE_GRID_CLASSNAME,
  CONNECT_CIRCLE_TILE_CLASSNAME,
  "mx-auto w-full max-w-[50rem] space-y-4",
  "flex size-24 items-center justify-center rounded-full",
  "ui-text-card-title max-w-full [overflow-wrap:anywhere]",
  "ui-text-row-description max-w-full",
  primaryButtonClass,
  secondaryButtonClass,
  "size-4",
];

let fixtureUrl: string;

test.beforeAll(async () => {
  const root = process.cwd();
  const { compile } = (await import(
    pathToFileURL(path.join(root, "node_modules/tailwindcss/dist/lib.mjs")).href
  )) as {
    compile: (
      css: string,
      options: unknown,
    ) => Promise<{ build: (values: string[]) => string }>;
  };
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "connect-living-layout-"));
  fs.writeFileSync(
    path.join(dir, "fixture.css"),
    compiler.build(fixtureClasses.flatMap((classes) => classes.split(/\s+/))),
  );
  fs.writeFileSync(
    path.join(dir, "fixture.html"),
    `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="fixture.css"></head>
    <body style="margin:0;background:#f7f8ff"><main class="mx-auto w-full max-w-[50rem] space-y-4" style="padding:16px;box-sizing:border-box">
      <section data-test="hero" class="${CONNECT_HERO_CLASSNAME}">
        <div class="${CONNECT_HERO_ORBIT_CLASSNAME}" data-test="orbit"></div>
        <h2>Bring your people closer</h2>
        <p>Connect with someone you trust, then create shared circles together.</p>
        <div data-test="actions" class="${CONNECT_HERO_ACTIONS_CLASSNAME}">
          <button class="${primaryButtonClass}"><span class="size-4" aria-hidden="true"></span>Find your first connection</button>
          <button class="${secondaryButtonClass}"><span class="size-4" aria-hidden="true"></span>Explore circles</button>
        </div>
      </section>
      <section data-test="grid" class="${CONNECT_CIRCLE_GRID_CLASSNAME}">
        ${[1, 2, 3].map((i) => `<button data-test="tile" class="${CONNECT_CIRCLE_TILE_CLASSNAME}"><span class="flex size-24 items-center justify-center rounded-full">${i}</span><span class="ui-text-card-title max-w-full [overflow-wrap:anywhere]">${i === 2 ? "Superlongunbrokencirclenameforfriendsandfamily" : "A very long circle name that needs room to wrap"}</span><span class="ui-text-row-description max-w-full">17 people</span></button>`).join("")}
      </section>
    </main></body></html>`,
  );
  fixtureUrl = pathToFileURL(path.join(dir, "fixture.html")).href;
});

for (const width of widths) {
  test(`Connect hero and circle tiles fit without overlap at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(fixtureUrl);
    const geometry = await page.evaluate(() => {
      const rect = (element: Element) => element.getBoundingClientRect();
      const hero = rect(document.querySelector('[data-test="hero"]')!);
      const orbit = rect(document.querySelector('[data-test="orbit"]')!);
      const actions = rect(document.querySelector('[data-test="actions"]')!);
      const grid = rect(document.querySelector('[data-test="grid"]')!);
      const tiles = Array.from(document.querySelectorAll('[data-test="tile"]')).map(rect);
      const buttons = Array.from(document.querySelectorAll('[data-test="actions"] button')).map(rect);
      return {
        viewport: document.documentElement.clientWidth,
        pageWidth: document.documentElement.scrollWidth,
        hero: { left: hero.left, right: hero.right, bottom: hero.bottom },
        orbit: { bottom: orbit.bottom },
        actions: { top: actions.top },
        grid: { left: grid.left, right: grid.right, top: grid.top },
        tiles: tiles.map((r) => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom })),
        buttons: buttons.map((r) => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom })),
      };
    });
    expect(geometry.pageWidth).toBeLessThanOrEqual(geometry.viewport);
    expect(geometry.orbit.bottom).toBeLessThanOrEqual(geometry.actions.top);
    expect(geometry.hero.bottom).toBeLessThanOrEqual(geometry.grid.top);
    for (const tile of geometry.tiles) {
      expect(tile.left).toBeGreaterThanOrEqual(geometry.grid.left - 1);
      expect(tile.right).toBeLessThanOrEqual(geometry.grid.right + 1);
    }
    const [first, second] = geometry.buttons;
    expect(first && second).toBeTruthy();
    expect(first!.right <= second!.left || first!.bottom <= second!.top).toBe(true);
    if (width < 360) {
      expect(geometry.tiles[0].bottom).toBeLessThanOrEqual(geometry.tiles[1].top);
    }
  });
}
