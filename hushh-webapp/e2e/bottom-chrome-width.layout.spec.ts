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

test("shared dock retains material and input identity with aligned edges and keyboard clearance", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  for (const width of [320, 393, 768]) {
    await open(page, width, false, { name: "shared text dock", html: { composer: "true" } }, errors);
    const dock = page.locator("[data-agent-dock-surface]");
    const input = page.getByRole("textbox", { name: "Message One" });
    await expect(input).toBeVisible();
    const retainedBar = await dock.elementHandle();
    const retainedInput = await input.elementHandle();
    const measureInput = () => input.evaluate(node => {
      const field = node as HTMLTextAreaElement;
      const frame = field.getBoundingClientRect();
      const surface = field.closest("[data-agent-dock-surface]")!.getBoundingClientRect();
      return {
        height: frame.height, contentHeight: field.scrollHeight,
        within: frame.left >= surface.left && frame.right <= surface.right,
        radius: getComputedStyle(field).borderRadius,
      };
    });
    await input.fill(Array.from({ length: 30 }, (_, i) => `Line ${i + 1}: ${"wrappedtext".repeat(8)}`).join("\n"));
    const multiline = await measureInput();
    expect(multiline.within).toBe(true);
    expect(multiline.height).toBeLessThanOrEqual(160);
    expect(multiline.contentHeight).toBeGreaterThan(multiline.height);
    expect(multiline.radius).toBe("0px");
    const sendFrame = await page.getByRole("button", { name: "Send message" }).boundingBox();
    const inputFrame = await input.boundingBox();
    expect(inputFrame!.x + inputFrame!.width).toBeLessThanOrEqual(sendFrame!.x);
    expect(sendFrame!.width).toBeGreaterThanOrEqual(44);
    await input.fill("");
    expect((await measureInput()).height).toBeLessThanOrEqual(48);
    const emptyTextFrame = await dock.boundingBox();
    const material = () => dock.evaluate(node => {
      const style = getComputedStyle(node);
      return { radius: style.borderRadius, background: style.backgroundColor, border: style.borderWidth };
    });
    const textMaterial = await material();
    await page.getByTestId("fixture-route").click();
    await expect(input).toHaveCount(0);
    await expect.poll(async () => {
      const frame = await dock.boundingBox();
      return Math.max(...(["x", "y", "width", "height"] as const)
        .map(key => Math.abs(emptyTextFrame![key] - frame![key])));
    }, { message: "Route handoff must settle to the identical Agent Bar frame" }).toBeLessThanOrEqual(EDGE_TOLERANCE_PX);
    expect(await material()).toEqual(textMaterial);
    expect(await dock.evaluate((node, original) => node === original, retainedBar)).toBe(true);
    await page.getByTestId("fixture-route").click();
    await expect(input).toBeVisible();
    // Routes retain the outer surface, not an unmounted route's textarea.
    await retainedInput?.dispose();
    const currentInput = await input.elementHandle();
    await input.fill("Unsent synthetic draft");
    const barFrame = await dock.boundingBox();
    const navFrame = await page.locator(".kai-bottom-nav-pill").boundingBox();
    expect(Math.abs(barFrame!.x - navFrame!.x)).toBeLessThanOrEqual(EDGE_TOLERANCE_PX);
    expect(Math.abs(barFrame!.width - navFrame!.width)).toBeLessThanOrEqual(EDGE_TOLERANCE_PX);
    await page.getByTestId("fixture-mode").click();
    await expect(input).toBeHidden();
    await page.getByTestId("fixture-mode").click();
    await expect(input).toHaveValue("Unsent synthetic draft");
    expect(await input.evaluate((node, original) => node === original, currentInput)).toBe(true);
    expect(await dock.evaluate((node, original) => node === original, retainedBar)).toBe(true);
    await page.evaluate(() => {
      document.documentElement.classList.add("native-keyboard-inset", "kb-open");
      document.documentElement.style.setProperty("--kb-height", "280px");
    });
    await expect(page.locator("[data-bottom-shell-navigation-slot]")).toBeHidden();
    await expect.poll(async () => {
      const frame = await input.boundingBox();
      return frame ? Math.round(844 - 280 - frame.y - frame.height) : -1;
    }).toBeGreaterThanOrEqual(7);
    await expect.poll(async () => {
      const frame = await dock.boundingBox();
      return frame ? Math.round(844 - 280 - frame.y - frame.height) : -1;
    }).toBeLessThanOrEqual(9);
    await page.evaluate(() => {
      document.documentElement.classList.remove("native-keyboard-inset", "kb-open");
      document.documentElement.style.removeProperty("--kb-height");
    });
    await page.getByTestId("fixture-route").click();
    await expect(input).toHaveCount(0);
    expect(await dock.evaluate((node, original) => node === original, retainedBar)).toBe(true);
    expect(errors).toEqual([]);
    await currentInput?.dispose();
    await retainedBar?.dispose();
  }
});

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

for (const width of [393, 1440])
  for (const dark of [false, true])
    for (const profile of [false, true])
      test(`navigation uses its accent immediately: ${width}px ${dark ? "dark" : "light"} ${profile ? "profile" : "standard"}`, async ({ page }) => {
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await open(page, width, dark, VARIANTS[0], errors);
        if (profile) {
          await page.locator("[data-fixture-page]").evaluate((element) => {
            element.classList.add("profile-account-content");
          });
        }
        const selected = page.getByRole("radio", { name: "Connect" });
        const accent = await selected.evaluate((element) => getComputedStyle(element).color);
        for (const label of ["Chat", "One", "Feed", "Search"]) {
          const button = page.getByRole("radio", { name: label });
          await button.hover();
          await page.mouse.down();
          const pressed = await button.evaluate((element) => ({
            color: getComputedStyle(element).color,
            transitions: getComputedStyle(element).transitionProperty,
          }));
          expect(pressed.color, `${label} press color`).toBe(accent);
          expect(pressed.transitions).not.toMatch(/color|all/);
          await page.mouse.move(0, 0);
          await page.mouse.up();
        }
        expect(errors).toEqual([]);
      });

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
