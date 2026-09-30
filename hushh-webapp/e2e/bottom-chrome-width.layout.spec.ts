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
 * The "Talk to One" bar and the navigation bar under it are ONE column.
 *
 * Founder report, 2026-09-29: "talk to one bar and the bottom bar width is not
 * the same". They had two width sources and two gutter formulas: the voice
 * bar capped at `--app-agent-bar-max-width` (34rem) inside `100vw - 2rem`, the
 * navigation at `--app-bottom-shell-max-width` (48rem, 40rem from 1280px)
 * inside `100vw - 1.5rem`, re-capped at `100vw - 2rem`, and a /one/location
 * frame of 45rem on top. On a phone the caps happened to coincide; from about
 * 576px up the two pills parted (544px over 736px at 768, 544px over 640px at
 * 1440), and `100vw` counted a desktop scrollbar the shell never covers.
 *
 * This renders the production `AppBottomShell` (the command bar, the One Live
 * Voice dock, and its expanded conversation panel) and holds the left and
 * right edges of both bars equal within half a pixel at every supported
 * width, light and dark, on the web and in the native iOS inset model, with
 * the keyboard up, and again with every label widened, because CI's Linux
 * fonts set about 1.5px wider than a Mac.
 *
 * Set BOTTOM_CHROME_SHOT_DIR to also capture screenshots.
 */

const WIDTHS = [320, 375, 393, 430, 768, 1440] as const;
const EDGE_TOLERANCE_PX = 0.5;

type Variant = {
  name: string;
  html: Record<string, string>;
  htmlClass?: string;
  /** The widths this state exists at. */
  widths?: readonly number[];
};

const VARIANTS: Variant[] = [
  { name: "web command bar", html: {} },
  { name: "web live voice", html: { agent: "live" } },
  {
    name: "live voice expanded",
    html: { agent: "live", voice: "expanded" },
  },
  { name: "command bar working", html: { command: "working" } },
  { name: "location route", html: { path: "/one/location" } },
  { name: "native ios", html: {}, htmlClass: "native-ios" },
  {
    // The native shell keeps the chrome while the keyboard is up (it simply
    // covers it); the mobile-web fade is a separate, opacity-only rule.
    name: "native keyboard up",
    html: {},
    htmlClass: "native-ios native-keyboard-inset kb-open",
  },
  {
    // The desktop history column moves the shell's left edge to 15rem, so a
    // viewport-relative width overran the column it sits in.
    name: "chat history column open",
    html: { oneChatSidebar: "open" },
    widths: [1440],
  },
];

let script: string;
let css: string;

test.beforeAll(async () => {
  const root = process.cwd();
  const { build } = await import("vite");
  const { Scanner } = await import("@tailwindcss/oxide");
  const scanner = new Scanner({});
  const candidates = new Set<string>();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "bottom-chrome-width-"));
  const boundaries = path.join(root, "e2e/fixtures/bottom-shell-boundaries.tsx");
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
        ...[
          "next/navigation",
          "@/hooks/use-auth",
          "@/lib/vault/vault-context",
          "@/lib/consent/use-consent-pending-summary-count",
          "@/lib/feed/use-feed-unread-count",
          "@/lib/one-voice/readiness",
          "@/components/one-voice/voice-session-provider",
          "@/components/one-voice/tool-result-card",
          "@/components/one-location/onboarding/location-onboarding-interaction-surface",
        ].map((find) => ({ find, replacement: boundaries })),
        {
          find: /^(\.\/|@\/components\/agent\/)location-command-provider$/,
          replacement: boundaries,
        },
        {
          find: /^(\.\/|@\/components\/one-voice\/)tool-result-card$/,
          replacement: boundaries,
        },
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
        entry: path.join(root, "e2e/fixtures/bottom-shell.tsx"),
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

async function open(page: Page, width: number, dark: boolean, variant: Variant, errors: string[]) {
  await page.setViewportSize({ width, height: 844 });
  const attributes = Object.entries(variant.html)
    .map(
      ([key, value]) =>
        `data-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}="${value}"`,
    )
    .join(" ");
  const htmlClass = [dark ? "dark" : "", variant.htmlClass ?? ""].join(" ").trim();
  const url = "http://localhost/bottom-chrome-width";
  await page.route(url, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html class="${htmlClass}" ${attributes}><head><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><style>${css}</style></head><body><div id="root"></div></body></html>`,
    }),
  );
  await page.goto(url);
  await page.addScriptTag({ content: script });
  await awaitProductFont(page);
  try {
    await page.locator("[data-testid='one-voice-agent-bar']").waitFor({ timeout: 5_000 });
  } catch (error) {
    throw new Error(`Bottom shell did not mount: ${errors.join(" | ") || String(error)}`);
  }
  await page.locator(".kai-bottom-nav-pill").waitFor();
  if (variant.html.voice === "expanded")
    await page.locator("[data-testid='one-voice-panel']").waitFor();
}

type Edges = { left: number; right: number; width: number };
type Measure = {
  voice: Edges;
  navigation: Edges;
  panel: Edges | null;
  shell: Edges;
};

function measure(page: Page): Promise<Measure> {
  return page.evaluate(() => {
    const edges = (element: Element | null) => {
      if (!element) return null;
      const box = element.getBoundingClientRect();
      return { left: box.left, right: box.right, width: box.width };
    };
    return {
      voice: edges(document.querySelector("[data-testid='one-voice-agent-bar']"))!,
      navigation: edges(document.querySelector(".kai-bottom-nav-pill"))!,
      panel: edges(document.querySelector("[data-testid='one-voice-panel']")),
      shell: edges(document.querySelector("[data-app-bottom-shell]"))!,
    };
  });
}

function assertOneColumn(measured: Measure, label: string) {
  const { voice, navigation, panel, shell } = measured;
  const detail = `${label}: Talk to One ${voice.left.toFixed(2)}..${voice.right.toFixed(2)} (${voice.width.toFixed(2)}px), navigation ${navigation.left.toFixed(2)}..${navigation.right.toFixed(2)} (${navigation.width.toFixed(2)}px)`;
  expect.soft(Math.abs(voice.left - navigation.left), `${detail}: left edges`).toBeLessThanOrEqual(EDGE_TOLERANCE_PX);
  expect.soft(Math.abs(voice.right - navigation.right), `${detail}: right edges`).toBeLessThanOrEqual(EDGE_TOLERANCE_PX);
  if (panel) {
    expect.soft(Math.abs(panel.left - navigation.left), `${label}: voice panel left edge`).toBeLessThanOrEqual(EDGE_TOLERANCE_PX);
    expect.soft(Math.abs(panel.right - navigation.right), `${label}: voice panel right edge`).toBeLessThanOrEqual(EDGE_TOLERANCE_PX);
  }
  // The column is centred in the shell it lives in: equal insets both sides.
  const leftInset = navigation.left - shell.left;
  const rightInset = shell.right - navigation.right;
  expect.soft(Math.abs(leftInset - rightInset), `${label}: insets ${leftInset.toFixed(2)} / ${rightInset.toFixed(2)}`).toBeLessThanOrEqual(EDGE_TOLERANCE_PX);
  // Never flush to the screen edge on a phone.
  expect.soft(leftInset, `${label}: left inset`).toBeGreaterThanOrEqual(12);
}

for (const variant of VARIANTS)
  for (const width of variant.widths ?? WIDTHS)
    for (const dark of [false, true])
      test(`Talk to One and navigation share one column: ${variant.name} at ${width}px ${dark ? "dark" : "light"}`, async ({
        page,
      }) => {
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await open(page, width, dark, variant, errors);
        const label = `${variant.name} ${width}px ${dark ? "dark" : "light"}`;

        assertOneColumn(await measure(page), label);

        const shotDir = process.env.BOTTOM_CHROME_SHOT_DIR;
        if (shotDir && (width === 393 || width === 1440)) {
          fs.mkdirSync(shotDir, { recursive: true });
          const slug = variant.name.replace(/\s+/g, "-");
          await page.screenshot({
            path: path.join(shotDir, `shell-bars-${slug}-${width}-${dark ? "dark" : "light"}.png`),
            animations: "disabled",
          });
          fs.writeFileSync(
            path.join(shotDir, `shell-bars-${slug}-${width}-${dark ? "dark" : "light"}.json`),
            JSON.stringify(await measure(page), null, 2),
          );
        }

        // Widened labels: the column is set by the shell, never by its text.
        await page.addStyleTag({
          content:
            ".kai-bottom-nav-pill [role=radio] span,[data-testid='one-voice-agent-bar'] span{letter-spacing:0.3px}",
        });
        assertOneColumn(await measure(page), `${label} widened`);
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
        ).toBe(true);
        expect(errors).toEqual([]);
      });
