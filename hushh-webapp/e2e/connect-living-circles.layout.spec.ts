import { expect, test } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  CONNECT_CIRCLE_GRID_CLASSNAME,
  CONNECT_CIRCLE_TILE_CLASSNAME,
} from "../components/connect/connect-living-layout";
import {
  CONNECT_SWIPE_CLIP_GUARD_CLASSNAME,
  CONNECT_SWIPE_PANE_INSET_CLASSNAME,
} from "../app/connect/connect-surface-layout";
import { cn } from "../lib/utils";

const widths = [320, 360, 390, 430, 768, 1440] as const;
const orbitClass = "relative mx-auto size-[14rem] sm:size-[17rem]";
const growthCardClass = "overflow-hidden rounded-[var(--app-card-radius-standard)] border border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-default-solid)] px-4 py-6 sm:px-6";
const candidateGridClass = "mt-4 grid grid-cols-1 gap-2 min-[430px]:grid-cols-2";
const fixtureClasses = [
  orbitClass,
  CONNECT_CIRCLE_GRID_CLASSNAME,
  CONNECT_CIRCLE_TILE_CLASSNAME,
  growthCardClass,
  candidateGridClass,
  cn("w-full min-h-0 overflow-hidden", CONNECT_SWIPE_CLIP_GUARD_CLASSNAME),
  CONNECT_SWIPE_PANE_INSET_CLASSNAME,
  "flex w-full min-h-0 transform-gpu",
  "flex-[0_0_100%] min-h-0 min-w-0 max-w-full",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent-ring)]",
  "mx-auto w-full max-w-[50rem] space-y-4",
  "relative size-full sm:hidden",
  "relative hidden size-full sm:block",
  "absolute left-1/2 top-1/2 size-16 -translate-x-1/2 -translate-y-1/2 rounded-full",
  "absolute z-10 size-10 -translate-x-1/2 -translate-y-1/2 rounded-full",
  "flex w-full min-w-0 items-start justify-between gap-3",
  "flex h-11 min-w-0 items-center",
  "flex items-center -space-x-2",
  "relative inline-flex size-11 shrink-0 items-center justify-center rounded-full border-2 border-[color:var(--app-card-surface-default-solid)] bg-[color:var(--app-card-surface-default-solid)]",
  "ml-2 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full",
  "rounded-[var(--app-card-radius-standard)] bg-[color:var(--app-card-surface-default-solid)] px-[var(--surface-card-content-px)] py-4",
  "ui-text-card-title mt-4 max-w-full [overflow-wrap:anywhere] text-[color:var(--app-primary-label)]",
  "ui-text-row-description mt-1 max-w-full text-[color:var(--app-secondary-label)]",
  "flex min-w-0 items-center gap-2 rounded-[var(--app-card-radius-compact)] px-2.5 py-2",
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
      <section class="rounded-[var(--app-card-radius-standard)] bg-[color:var(--app-card-surface-default-solid)] px-[var(--surface-card-content-px)] py-4">
        <h2>Your circles</h2>
        <div data-test="grid" class="${CONNECT_CIRCLE_GRID_CLASSNAME}">
        ${[1, 2, 3].map((i) => `<button data-test="tile" class="${CONNECT_CIRCLE_TILE_CLASSNAME}"><span class="flex w-full min-w-0 items-start justify-between gap-3"><span data-test="circle-preview" class="flex h-11 min-w-0 items-center"><span class="flex items-center -space-x-2">${[1, 2, 3, 4].map(() => `<span data-test="circle-avatar" class="relative inline-flex size-11 shrink-0 items-center justify-center rounded-full border-2 border-[color:var(--app-card-surface-default-solid)] bg-[color:var(--app-card-surface-default-solid)]"></span>`).join("")}</span>${i === 1 ? '<span class="ml-2 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full" style="background:#ec3c40;color:white;font-size:8px">SMS</span>' : ""}</span><span aria-hidden="true">›</span></span><span class="ui-text-card-title mt-4 max-w-full [overflow-wrap:anywhere] text-[color:var(--app-primary-label)]">${i === 2 ? "Superlongunbrokencirclenameforfriendsandfamily" : "A very long circle name that needs room to wrap"}</span><span class="ui-text-row-description mt-1 max-w-full text-[color:var(--app-secondary-label)]">17 people</span></button>`).join("")}
        </div>
      </section>
      <section data-test="growth" class="${growthCardClass}">
        ${orbitMarkup()}
        <div data-test="candidates" class="${candidateGridClass}">
          ${[1, 2, 3, 4].map((i) => `<div data-test="candidate" class="flex min-w-0 items-center gap-2 rounded-[var(--app-card-radius-compact)] px-2.5 py-2" style="background:#f3f5fb">Connection ${i}</div>`).join("")}
        </div>
      </section>
      <h2 data-test="pager-alignment">Connect</h2>
      <div data-test="pager" class="${cn("w-full min-h-0 overflow-hidden", CONNECT_SWIPE_CLIP_GUARD_CLASSNAME)}">
        <div data-test="pager-track" class="flex w-full min-h-0 transform-gpu">
          <div class="flex-[0_0_100%] min-h-0 min-w-0 max-w-full"></div>
          <div class="flex-[0_0_100%] min-h-0 min-w-0 max-w-full">
            <div class="${CONNECT_SWIPE_PANE_INSET_CLASSNAME}">
              <p data-test="pager-copy">Bring people together for the things you share.</p>
              <div class="${CONNECT_CIRCLE_GRID_CLASSNAME}">
                <button data-test="pager-first-tile" class="${CONNECT_CIRCLE_TILE_CLASSNAME}">Trusted</button>
                <button class="${CONNECT_CIRCLE_TILE_CLASSNAME}">SMS Circle</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </main></body></html>`,
  );
  fixtureUrl = pathToFileURL(path.join(dir, "fixture.html")).href;
});

for (const width of widths) {
  test(`Circle tiles and member orbits fit without overlap at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(fixtureUrl);
    const geometry = await page.evaluate(() => {
      const rect = (element: Element) => element.getBoundingClientRect();
      const grid = rect(document.querySelector('[data-test="grid"]')!);
      const tiles = Array.from(document.querySelectorAll('[data-test="tile"]')).map(rect);
      const previews = Array.from(document.querySelectorAll('[data-test="circle-preview"]')).map(rect);
      const avatars = Array.from(document.querySelectorAll('[data-test="circle-avatar"]')).map(rect);
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
        grid: { left: grid.left, right: grid.right, top: grid.top },
        tiles: tiles.map((r) => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom })),
        previews: previews.map((r) => ({ left: r.left, right: r.right })),
        avatars: avatars.map((r) => ({ left: r.left, right: r.right })),
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
    for (const tile of geometry.tiles) {
      expect(tile.left).toBeGreaterThanOrEqual(geometry.grid.left - 1);
      expect(tile.right).toBeLessThanOrEqual(geometry.grid.right + 1);
    }
    for (let index = 0; index < geometry.previews.length; index += 1) {
      expect(geometry.previews[index].left).toBeGreaterThanOrEqual(geometry.tiles[index].left);
      expect(geometry.previews[index].right).toBeLessThanOrEqual(geometry.tiles[index].right);
    }
    for (let index = 0; index < geometry.avatars.length; index += 1) {
      const tile = geometry.tiles[Math.floor(index / 4)];
      expect(geometry.avatars[index].left).toBeGreaterThanOrEqual(tile.left);
      expect(geometry.avatars[index].right).toBeLessThanOrEqual(tile.right);
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
    if (width < 640) {
      expect(geometry.tiles[0].bottom).toBeLessThanOrEqual(geometry.tiles[1].top);
    } else {
      expect(geometry.tiles[0].top).toBeCloseTo(geometry.tiles[1].top, 0);
    }
  });
}

for (const width of [320, 390, 1440] as const) {
  test(`Connect swipe clipping leaves the Circles copy and focus ring intact at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(fixtureUrl);
    const geometry = await page.evaluate(() => {
      const pager = document.querySelector<HTMLElement>('[data-test="pager"]')!;
      const track = document.querySelector<HTMLElement>('[data-test="pager-track"]')!;
      const copy = document.querySelector<HTMLElement>('[data-test="pager-copy"]')!;
      const tile = document.querySelector<HTMLElement>('[data-test="pager-first-tile"]')!;
      const alignment = document.querySelector<HTMLElement>('[data-test="pager-alignment"]')!;
      const viewport = pager.getBoundingClientRect();
      const measure = () => ({
        copy: copy.getBoundingClientRect(),
        tile: tile.getBoundingClientRect(),
      });
      track.style.transform = `translate3d(-${pager.clientWidth}px, 0, 0)`;
      const settled = measure();
      // A drag can render between device pixels before the final Embla snap.
      track.style.transform = `translate3d(-${pager.clientWidth + 3}px, 0, 0)`;
      const inMotion = measure();
      return {
        viewport: { left: viewport.left, right: viewport.right },
        alignmentLeft: alignment.getBoundingClientRect().left,
        settled: {
          copyLeft: settled.copy.left,
          tileLeft: settled.tile.left,
          tileRight: settled.tile.right,
        },
        inMotion: {
          copyLeft: inMotion.copy.left,
          tileLeft: inMotion.tile.left,
          tileRight: inMotion.tile.right,
        },
        pageWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      };
    });
    expect(geometry.settled.copyLeft).toBeCloseTo(geometry.alignmentLeft, 0);
    expect(geometry.settled.tileLeft).toBeCloseTo(geometry.alignmentLeft, 0);
    for (const state of [geometry.settled, geometry.inMotion]) {
      // Two pixels for the keyboard ring, plus tolerance for raster rounding.
      expect(state.copyLeft).toBeGreaterThanOrEqual(geometry.viewport.left + 4);
      expect(state.tileLeft).toBeGreaterThanOrEqual(geometry.viewport.left + 4);
      expect(state.tileRight).toBeLessThanOrEqual(geometry.viewport.right - 4);
    }
    expect(geometry.pageWidth).toBeLessThanOrEqual(geometry.clientWidth);
  });
}
