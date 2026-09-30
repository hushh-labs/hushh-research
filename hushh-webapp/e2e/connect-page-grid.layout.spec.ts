import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  awaitProductFont,
  productFontStyle,
  stripAppFontFaces,
} from "./fixtures/product-font";

/**
 * The Connect page on its grid, and still while it loads.
 *
 * Renders the production page (`app/connect/page-client.tsx`) with an inert
 * network that answers on timers, so it loads the way it does for a person:
 * the page, then the connections list, then the circles read.
 *
 * 1. Grid. Founder, 2026-09-29: "the border and padding for the my
 *    connections can be removed on the connect page, it can be grid
 *    symmetrical". "My connections" sat in its own bordered, filled pill, 13px
 *    in from the column every other section starts on, and both section
 *    headings sat 4px in from it. Every section's leading edge (the hero
 *    card, the tab rail, both headings, both lists, the search field) now
 *    shares the page's content column, and the trailing controls end on its
 *    right edge.
 *
 * 2. Stillness. Founder, same day: "when the connect page loads the 'Your
 *    Trusted Circle' written bounces up and down the div around it". The
 *    hero's footer row grew twice as the page loaded (16px of loading copy,
 *    then 28px of avatars, then the 44px Trusted Circle link once circles
 *    answered), pushing everything under it; the card also slid 8px up as it
 *    mounted; and on a single-column layout the tour's description changed
 *    height every three seconds. The block, and the section under it, now
 *    hold one geometry from the first frame to settled, and the layout-shift
 *    score over that window is zero.
 *
 * Both run light and dark, and the grid again with its labels widened,
 * because CI's Linux fonts set about 1.5px wider than a Mac.
 * Set CONNECT_GRID_SHOT_DIR to also capture screenshots.
 */

const WIDTHS = [320, 375, 393, 430, 768, 1440] as const;
const EDGE_TOLERANCE_PX = 0.5;

const STUBBED = [
  "next/navigation",
  "@/hooks/use-auth",
  "@/lib/vault/vault-context",
  "@/lib/firebase/config",
  "@/lib/services/connections-service",
  "@/lib/services/cache-service",
  "@/lib/cache/cache-sync-service",
  "@/lib/one-location/service",
  "@/lib/contacts/use-contact-sync",
  "@/lib/voice/voice-surface-metadata",
  "@/lib/agent/local-onboarding-actions",
  "@/lib/connections/use-outgoing-request-resolution-watch",
  "@/lib/connections/connection-graph-events",
  "@/components/connect/circles/connect-circles-tab",
  "@/components/connect/nearby-directories",
  "@/components/one-location/contact-sync-results-sheet",
  "@/components/connections/contact-discoverability-consent-dialog",
  "@/components/one-location/onboarding/location-onboarding-interaction-surface",
];

let script: string;
let css: string;

test.beforeAll(async () => {
  const root = process.cwd();
  const { build } = await import("vite");
  const { Scanner } = await import("@tailwindcss/oxide");
  const scanner = new Scanner({});
  const candidates = new Set<string>();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "connect-page-grid-"));
  const boundaries = path.join(root, "e2e/fixtures/connect-page-boundaries.tsx");
  await build({
    configFile: false,
    logLevel: "error",
    oxc: { jsx: { runtime: "automatic" } },
    plugins: [
      {
        name: "fixture-css-candidates",
        transform(source, id) {
          if (!id.includes("node_modules") && /\.[tj]sx?$/.test(id))
            for (const candidate of scanner.scanFiles([
              { content: source, extension: "tsx" },
            ]))
              candidates.add(candidate);
        },
      },
    ],
    resolve: {
      alias: [
        ...STUBBED.map((find) => ({ find, replacement: boundaries })),
        { find: "@", replacement: root },
      ],
    },
    define: {
      "process.env.NODE_ENV": JSON.stringify("production"),
      "process.env": "{}",
    },
    build: {
      outDir,
      emptyOutDir: false,
      lib: {
        entry: path.join(root, "e2e/fixtures/connect-page.tsx"),
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
              ? path.join(root, "node_modules/tw-animate-css/dist/tw-animate.css")
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

type Timings = { connectionsMs: number; circlesMs: number; directoryMs: number };

/** Loads the page. `beforeScript` runs in the document before React does. */
async function open(
  page: Page,
  width: number,
  dark: boolean,
  timings: Timings = { connectionsMs: 0, circlesMs: 0, directoryMs: 0 },
  beforeScript?: () => void,
) {
  await page.setViewportSize({ width, height: 900 });
  const url = "http://localhost/connect-page-grid";
  await page.route(url, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html class="${dark ? "dark" : ""}" data-connections-ms="${timings.connectionsMs}" data-circles-ms="${timings.circlesMs}" data-directory-ms="${timings.directoryMs}"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div></body></html>`,
    }),
  );
  await page.goto(url);
  await awaitProductFont(page);
  if (beforeScript) await page.evaluate(beforeScript);
  await page.addScriptTag({ content: script });
}

async function settle(page: Page, width: number) {
  const group = page.getByTestId("connect-my-connections-group");
  // The page bundle is large; its first commit can take a few seconds under
  // parallel workers before the timed network even starts.
  await expect(group.locator("[data-voice-label]")).toHaveCount(6, { timeout: 30_000 });
  await expect(page.getByTestId("connect-directory-group").getByText("Avery Stone")).toBeVisible();
  if (width >= 640)
    await expect(page.getByRole("button", { name: /Your Trusted Circle/ })).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document
            .getAnimations()
            .filter(
              (animation) =>
                animation.playState === "running" &&
                // The spinner is a spinner.
                !(animation as CSSAnimation).animationName?.includes("spin"),
            ).length,
      ),
    )
    .toBe(0);
}

type Box = { left: number; right: number; top: number; bottom: number };
type Grid = {
  column: { left: number; right: number };
  leading: Record<string, number>;
  spans: Record<string, Box>;
  trailing: Record<string, number>;
  rows: Array<{ name: string; leadingInset: number; trailingInset: number }>;
};

function measureGrid(page: Page): Promise<Grid> {
  return page.evaluate(() => {
    const box = (element: Element | null | undefined): Box | null => {
      if (!element) return null;
      const r = element.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
    };
    const must = (selector: string, root: ParentNode = document) => {
      const element = root.querySelector(selector);
      if (!element) throw new Error(`missing ${selector}`);
      return element;
    };
    // The visible ink of an inline control: its first text-bearing element.
    const ink = (element: Element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const r = range.getBoundingClientRect();
      return { left: r.left, right: r.right };
    };
    const shell = must("[data-connect-page]") as HTMLElement;
    const shellBox = shell.getBoundingClientRect();
    const style = getComputedStyle(shell);
    const column = {
      left: shellBox.left + Number.parseFloat(style.paddingLeft),
      right: shellBox.right - Number.parseFloat(style.paddingRight),
    };
    const myGroup = must("[data-testid='connect-my-connections-group']");
    const directoryGroup = must("[data-testid='connect-directory-group']");
    const myToggle = must("[data-testid='connect-my-connections-toggle']");
    const directoryToggle = must("[aria-label^='Current directory']");
    const refresh = must("[aria-label='Refresh contacts']");
    const sync = document.querySelector("[aria-label='Sync contacts']");
    const rows = [...myGroup.querySelectorAll("[data-voice-label]")].map((row) => {
      const rowBox = row.getBoundingClientRect();
      const avatar = row.querySelector("[data-slot='avatar']") ?? row.querySelector("span");
      const trailing = row.querySelector("button[aria-label^='Remove']");
      return {
        name: row.getAttribute("data-voice-label") ?? "",
        leadingInset: avatar!.getBoundingClientRect().left - rowBox.left,
        trailingInset: rowBox.right - trailing!.getBoundingClientRect().right,
      };
    });
    return {
      column,
      leading: {
        "My connections heading": ink(myToggle.querySelector("span")!).left,
        "People heading": ink(directoryToggle.querySelector("span")!).left,
      },
      spans: {
        "tab rail": box(must("[data-testid='connect-sticky-header'] [role='tablist']"))!,
        "Circles card": box(must("[data-testid='connect-living-connections']"))!,
        "My connections list": box(must("[data-slot='settings-group-shell']", myGroup))!,
        "search field": box(must("[data-testid='connect-search-row'] input"))!,
        "People list": box(must("[data-slot='settings-group-shell']", directoryGroup))!,
      },
      trailing: {
        "refresh control": refresh.getBoundingClientRect().right,
        ...(sync ? { "Sync contacts control": sync.getBoundingClientRect().right } : {}),
      },
      rows,
    };
  });
}

function assertGrid(grid: Grid, label: string) {
  const { column } = grid;
  for (const [name, left] of Object.entries(grid.leading))
    expect.soft(Math.abs(left - column.left), `${label}: ${name} starts at ${left.toFixed(2)}, column at ${column.left.toFixed(2)}`).toBeLessThanOrEqual(EDGE_TOLERANCE_PX);
  for (const [name, span] of Object.entries(grid.spans)) {
    expect.soft(Math.abs(span.left - column.left), `${label}: ${name} left ${span.left.toFixed(2)} vs column ${column.left.toFixed(2)}`).toBeLessThanOrEqual(EDGE_TOLERANCE_PX);
    expect.soft(Math.abs(span.right - column.right), `${label}: ${name} right ${span.right.toFixed(2)} vs column ${column.right.toFixed(2)}`).toBeLessThanOrEqual(EDGE_TOLERANCE_PX);
  }
  for (const [name, right] of Object.entries(grid.trailing))
    expect.soft(Math.abs(right - column.right), `${label}: ${name} ends at ${right.toFixed(2)}, column at ${column.right.toFixed(2)}`).toBeLessThanOrEqual(EDGE_TOLERANCE_PX);
  expect(grid.rows.length, `${label}: connection rows`).toBe(6);
  for (const row of grid.rows) {
    expect.soft(Math.abs(row.leadingInset - row.trailingInset), `${label}: ${row.name} insets ${row.leadingInset.toFixed(2)} / ${row.trailingInset.toFixed(2)}`).toBeLessThanOrEqual(EDGE_TOLERANCE_PX);
    // On the 4pt grid.
    expect.soft(row.leadingInset % 4, `${label}: ${row.name} inset ${row.leadingInset} on the 4pt grid`).toBeLessThanOrEqual(EDGE_TOLERANCE_PX);
  }
}

for (const dark of [false, true])
  for (const width of WIDTHS)
    test(`Connect sections share one column at ${width}px ${dark ? "dark" : "light"}`, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await open(page, width, dark);
      await settle(page, width);
      const label = `${width}px ${dark ? "dark" : "light"}`;
      const grid = await measureGrid(page);
      assertGrid(grid, label);

      // Bare heading: no border, fill or padding box of its own.
      const heading = await page
        .getByTestId("connect-my-connections-toggle")
        .evaluate((element) => {
          const style = getComputedStyle(element);
          return {
            border: style.borderTopWidth,
            background: style.backgroundColor,
            paddingLeft: style.paddingLeft,
          };
        });
      expect.soft(heading, `${label}: My connections heading is bare`).toEqual({
        border: "0px",
        background: "rgba(0, 0, 0, 0)",
        paddingLeft: "0px",
      });

      const shotDir = process.env.CONNECT_GRID_SHOT_DIR;
      if (shotDir && width === 393) {
        fs.mkdirSync(shotDir, { recursive: true });
        const theme = dark ? "dark" : "light";
        await page.screenshot({ path: path.join(shotDir, `connect-${width}-${theme}-top.png`), animations: "disabled" });
        await page.getByTestId("connect-my-connections-group").evaluate((element) => {
          const root = document.querySelector("[data-app-scroll-root]")!;
          root.scrollTop += element.getBoundingClientRect().top - 260;
        });
        await page.screenshot({ path: path.join(shotDir, `connect-${width}-${theme}-sections.png`), animations: "disabled" });
        fs.writeFileSync(path.join(shotDir, `connect-${width}-${theme}-grid.json`), JSON.stringify(grid, null, 2));
      }

      // The tour swaps the description every three seconds; the card keeps
      // one height across all six so nothing under it moves.
      const heights = new Set<number>();
      for (const name of ["Family", "Finance", "Investor", "Business", "Location", "SMS"]) {
        await page.getByRole("button", { name: new RegExp(`^Explore ${name} Circle`) }).click();
        heights.add(await page.getByTestId("connect-living-connections").evaluate((element) => Math.round(element.getBoundingClientRect().height * 10) / 10));
      }
      expect.soft([...heights], `${label}: card height across the tour`).toHaveLength(1);

      await page.addStyleTag({
        content: "[data-connect-page] span,[data-connect-page] button{letter-spacing:0.3px}",
      });
      assertGrid(await measureGrid(page), `${label} widened`);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
      expect(errors).toEqual([]);
    });

/**
 * Samples, every frame from before React's first commit until settled, where
 * the Circles card, its footer row, the Trusted Circle link and the heading
 * under the card are; and collects every layout-shift entry.
 */
function installLoadRecorder() {
  type Sample = { t: number; v: string };
  const w = window as unknown as {
    __samples: Sample[];
    __shifts: Array<{ value: number; sources: string[] }>;
    __stop: boolean;
  };
  w.__samples = [];
  w.__shifts = [];
  w.__stop = false;
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries() as Array<PerformanceEntry & { value: number; sources?: Array<{ node?: Node }> }>)
      w.__shifts.push({
        value: entry.value,
        sources: (entry.sources ?? []).map((source) => {
          const node = source.node as Element | undefined;
          return node?.getAttribute?.("data-testid") ?? node?.nodeName ?? "?";
        }),
      });
  }).observe({ type: "layout-shift", buffered: true });
  const round = (n: number) => Math.round(n * 10) / 10;
  const rect = (element: Element | null) => {
    if (!element || !(element as HTMLElement).offsetParent) return null;
    const r = element.getBoundingClientRect();
    return [round(r.top), round(r.height), round(r.left)];
  };
  const tick = () => {
    const card = document.querySelector("[data-testid='connect-living-connections']");
    const value = JSON.stringify({
      card: rect(card),
      footer: rect(document.querySelector("[data-circle-discovery-footer]")),
      trusted: rect(document.querySelector("[data-circle-discovery-trusted]")),
      below: rect(document.querySelector("[data-testid='connect-my-connections-toggle']")),
    });
    const samples = w.__samples;
    if (card && (!samples.length || samples[samples.length - 1].v !== value))
      samples.push({ t: Math.round(performance.now()), v: value });
    if (!w.__stop) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

for (const width of [393, 700, 768, 1440] as const)
  for (const dark of [false, true])
    test(`Circles card and Your Trusted Circle hold still while Connect loads at ${width}px ${dark ? "dark" : "light"}`, async ({ page }) => {
      await page.emulateMedia({ reducedMotion: "no-preference" });
      // Connections answer first, circles later: the order a person sees.
      await open(page, width, dark, { connectionsMs: 700, circlesMs: 1500, directoryMs: 300 }, installLoadRecorder);
      await settle(page, width);
      const recorded = await page.evaluate(() => {
        const w = window as unknown as { __samples: Array<{ t: number; v: string }>; __shifts: Array<{ value: number; sources: string[] }>; __stop: boolean };
        w.__stop = true;
        return { samples: w.__samples, shifts: w.__shifts };
      });
      const frames = recorded.samples.map((sample) => ({ t: sample.t, ...JSON.parse(sample.v) }));
      expect(frames.length, "the card rendered").toBeGreaterThan(0);
      const first = frames[0];
      const settled = frames[frames.length - 1];
      const label = `${width}px ${dark ? "dark" : "light"}`;
      const score = recorded.shifts.reduce((sum, shift) => sum + shift.value, 0);
      const shotDir = process.env.CONNECT_GRID_SHOT_DIR;
      if (shotDir) {
        fs.mkdirSync(shotDir, { recursive: true });
        fs.writeFileSync(
          path.join(shotDir, `connect-load-${width}-${dark ? "dark" : "light"}.json`),
          JSON.stringify({ layoutShiftScore: score, shifts: recorded.shifts, frames }, null, 2),
        );
      }
      // One geometry from the first frame the card exists to settled. `top`,
      // `height` and `left` per part; getBoundingClientRect includes
      // transforms, so an entrance slide counts as movement too.
      for (const part of ["card", "footer", "below"] as const) {
        const moved = frames.filter((frame) => JSON.stringify(frame[part]) !== JSON.stringify(first[part]));
        expect.soft(moved.map((frame) => `${frame.t}ms ${JSON.stringify(frame[part])}`), `${label}: ${part} moved from ${JSON.stringify(first[part])}`).toEqual([]);
      }
      if (width >= 640) {
        // The link arrives when circles answer and never moves after that.
        const shown = frames.filter((frame) => frame.trusted);
        expect(shown.length, `${label}: Trusted Circle link shown`).toBeGreaterThan(0);
        expect.soft([...new Set(shown.map((frame) => JSON.stringify(frame.trusted)))], `${label}: Trusted Circle link moved`).toHaveLength(1);
        // It lives inside the reserved row, never taller than it.
        expect.soft(settled.trusted[1]).toBeLessThanOrEqual(settled.footer[1]);
      }
      expect.soft(score, `${label}: layout shift ${JSON.stringify(recorded.shifts)}`).toBe(0);

    });
