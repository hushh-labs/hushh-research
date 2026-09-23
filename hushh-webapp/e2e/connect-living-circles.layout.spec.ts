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
} from "../components/connect/connect-living-layout";
import { buttonVariants } from "../lib/ui/button-variants";
import { getVariantStyles } from "../lib/morphy-ux/utils";

const widths = [320, 360, 390, 430, 768, 1440] as const;
const primaryButtonClass = `${buttonVariants({ variant: "ghost", size: "standard" })} ${getVariantStyles("blue", "fill")} gap-2`;
const secondaryButtonClass = `${buttonVariants({ variant: "ghost", size: "standard" })} ${getVariantStyles("none", "fade")} gap-2`;
const orbitClass = "relative mx-auto size-[14rem] sm:size-[17rem]";
const growthCardClass = "overflow-hidden rounded-[var(--app-card-radius-standard)] border border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-default-solid)] px-4 py-6 sm:px-6";
const candidateGridClass = "mt-4 grid grid-cols-1 gap-2 min-[430px]:grid-cols-2";
const fixtureClasses = [
  CONNECT_HERO_CLASSNAME,
  orbitClass,
  CONNECT_HERO_ACTIONS_CLASSNAME,
  CONNECT_CIRCLE_GRID_CLASSNAME,
  CONNECT_CIRCLE_TILE_CLASSNAME,
  growthCardClass,
  candidateGridClass,
  "mx-auto w-full max-w-[50rem] space-y-4",
  "relative size-full sm:hidden",
  "relative hidden size-full sm:block",
  "absolute left-1/2 top-1/2 size-16 -translate-x-1/2 -translate-y-1/2 rounded-full",
  "absolute z-10 size-10 -translate-x-1/2 -translate-y-1/2 rounded-full",
  "flex size-28 items-center justify-center rounded-full",
  "flex min-w-0 items-center gap-2 rounded-[var(--app-card-radius-compact)] px-2.5 py-2",
  "ui-text-card-title max-w-full [overflow-wrap:anywhere]",
  "ui-text-row-description max-w-full",
  primaryButtonClass,
  secondaryButtonClass,
  "size-4",
];

let fixtureUrl: string;

function radialNodes(count: number): string {
  return Array.from({ length: count }, (_, index) => {
    const angle = -Math.PI / 2 + index * 2 * Math.PI / count;
    const left = 50 + Math.cos(angle) * 38;
    const top = 50 + Math.sin(angle) * 38;
    return `<span data-test="radial-node" class="absolute z-10 size-10 -translate-x-1/2 -translate-y-1/2 rounded-full" style="left:${left}%;top:${top}%;background:#dce8ff"></span>`;
  }).join("");
}

function orbitMarkup(): string {
  return `<div class="${orbitClass}" data-test="orbit">
    <div class="relative size-full sm:hidden" data-test="orbit-mobile"><span data-test="center" class="absolute left-1/2 top-1/2 size-16 -translate-x-1/2 -translate-y-1/2 rounded-full" style="background:#0874ed"></span>${radialNodes(4)}</div>
    <div class="relative hidden size-full sm:block" data-test="orbit-desktop"><span data-test="center" class="absolute left-1/2 top-1/2 size-16 -translate-x-1/2 -translate-y-1/2 rounded-full" style="background:#0874ed"></span>${radialNodes(6)}</div>
  </div>`;
}

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
        ${orbitMarkup()}
        <h2>Bring your people closer</h2>
        <p>Connect with someone you trust, then create shared circles together.</p>
        <div data-test="actions" class="${CONNECT_HERO_ACTIONS_CLASSNAME}">
          <button class="${primaryButtonClass}"><span class="size-4" aria-hidden="true"></span>Find your first connection</button>
          <button class="${secondaryButtonClass}"><span class="size-4" aria-hidden="true"></span>Explore circles</button>
        </div>
      </section>
      <section data-test="grid" class="${CONNECT_CIRCLE_GRID_CLASSNAME}">
        ${[1, 2, 3].map((i) => `<button data-test="tile" class="${CONNECT_CIRCLE_TILE_CLASSNAME}"><span class="flex size-28 items-center justify-center rounded-full">${i}</span><span class="ui-text-card-title max-w-full [overflow-wrap:anywhere]">${i === 2 ? "Superlongunbrokencirclenameforfriendsandfamily" : "A very long circle name that needs room to wrap"}</span><span class="ui-text-row-description max-w-full">17 people</span></button>`).join("")}
      </section>
      <section data-test="growth" class="${growthCardClass}">
        ${orbitMarkup()}
        <div data-test="candidates" class="${candidateGridClass}">
          ${[1, 2, 3, 4].map((i) => `<div data-test="candidate" class="flex min-w-0 items-center gap-2 rounded-[var(--app-card-radius-compact)] px-2.5 py-2" style="background:#f3f5fb">Connection ${i}</div>`).join("")}
        </div>
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
      const visibleOrbits = Array.from(document.querySelectorAll('[data-test="orbit"]')).map((orbit) => {
        const layout = Array.from(orbit.children).find((child) => getComputedStyle(child).display !== "none")!;
        return {
          bounds: rect(orbit),
          center: rect(layout.querySelector('[data-test="center"]')!),
          nodes: Array.from(layout.querySelectorAll('[data-test="radial-node"]')).map(rect),
        };
      });
      const growth = rect(document.querySelector('[data-test="growth"]')!);
      const candidates = Array.from(document.querySelectorAll('[data-test="candidate"]')).map(rect);
      return {
        viewport: document.documentElement.clientWidth,
        pageWidth: document.documentElement.scrollWidth,
        hero: { left: hero.left, right: hero.right, bottom: hero.bottom },
        orbit: { bottom: orbit.bottom },
        actions: { top: actions.top },
        grid: { left: grid.left, right: grid.right, top: grid.top },
        tiles: tiles.map((r) => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom })),
        buttons: buttons.map((r) => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom })),
        orbits: visibleOrbits.map(({ bounds, center, nodes }) => ({
          bounds: { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom },
          center: { left: center.left, right: center.right, top: center.top, bottom: center.bottom },
          nodes: nodes.map((r) => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom })),
        })),
        growth: { left: growth.left, right: growth.right },
        candidates: candidates.map((r) => ({ left: r.left, right: r.right })),
      };
    });
    expect(geometry.pageWidth).toBeLessThanOrEqual(geometry.viewport);
    expect(geometry.orbit.bottom).toBeLessThanOrEqual(geometry.actions.top);
    expect(geometry.hero.bottom).toBeLessThanOrEqual(geometry.grid.top);
    for (const tile of geometry.tiles) {
      expect(tile.left).toBeGreaterThanOrEqual(geometry.grid.left - 1);
      expect(tile.right).toBeLessThanOrEqual(geometry.grid.right + 1);
    }
    for (const orbit of geometry.orbits) {
      expect(orbit.nodes).toHaveLength(width < 640 ? 4 : 6);
      for (const node of orbit.nodes) {
        expect(node.left).toBeGreaterThanOrEqual(orbit.bounds.left - 1);
        expect(node.right).toBeLessThanOrEqual(orbit.bounds.right + 1);
        expect(node.top).toBeGreaterThanOrEqual(orbit.bounds.top - 1);
        expect(node.bottom).toBeLessThanOrEqual(orbit.bounds.bottom + 1);
        expect(node.right <= orbit.center.left || node.left >= orbit.center.right || node.bottom <= orbit.center.top || node.top >= orbit.center.bottom).toBe(true);
      }
    }
    for (const candidate of geometry.candidates) {
      expect(candidate.left).toBeGreaterThanOrEqual(geometry.growth.left - 1);
      expect(candidate.right).toBeLessThanOrEqual(geometry.growth.right + 1);
    }
    const [first, second] = geometry.buttons;
    expect(first && second).toBeTruthy();
    expect(first!.right <= second!.left || first!.bottom <= second!.top).toBe(true);
    if (width < 360) {
      expect(geometry.tiles[0].bottom).toBeLessThanOrEqual(geometry.tiles[1].top);
    }
  });
}
