import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  awaitProductFont,
  productFontStyle,
  stripAppFontFaces,
} from "./fixtures/product-font";

/**
 * Mount the shipping Toaster and Sonner package in a tiny React page. The
 * signed-in app cannot be reached without reviewer credentials, while a
 * hand-written toast would miss Sonner's own width and button rules.
 */
let fixtureDir: string | null = null;

async function buildFixture(theme: "light" | "dark"): Promise<string> {
  if (fixtureDir) {
    return pathToFileURL(path.join(fixtureDir, `fixture-${theme}.html`)).href;
  }
  const root = process.cwd();
  const cacheRoot = path.join(root, "node_modules/.cache");
  fs.mkdirSync(cacheRoot, { recursive: true });
  const dir = fs.mkdtempSync(path.join(cacheRoot, "sonner-layout-fixture-"));
  const entry = path.join(dir, "entry.tsx");
  fs.writeFileSync(
    entry,
    `import React, { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider } from "next-themes";
import { toast } from "sonner";
import { Toaster } from "@/components/ui/sonner";

const theme = document.documentElement.dataset.theme;
function Fixture() {
  useEffect(() => {
    (window as Window & { showFixtureToast?: (kind: "success" | "error") => void; toastActionClicked?: boolean }).showFixtureToast = (kind) => {
      toast.dismiss();
      toast[kind](
        "A long but readable confirmation about this person's connected information and access settings",
        {
          description: "The change is saved and ready to review.",
          action: { label: "Review", onClick: () => { (window as Window & { toastActionClicked?: boolean }).toastActionClicked = true; } },
          duration: Infinity,
        },
      );
    };
  }, []);
  return <Toaster closeButton />;
}
createRoot(document.getElementById("root")!).render(
  <ThemeProvider attribute="class" forcedTheme={theme} enableSystem={false}>
    <Fixture />
  </ThemeProvider>,
);
`,
  );

  const [{ build }, { default: react }, { compile }] = await Promise.all([
    import("vite"),
    import("@vitejs/plugin-react"),
    import(pathToFileURL(path.join(root, "node_modules/tailwindcss/dist/lib.mjs")).href),
  ]);
  await build({
    configFile: false,
    root,
    publicDir: false,
    plugins: [react()],
    resolve: { alias: { "@": root } },
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    build: {
      outDir: dir,
      emptyOutDir: false,
      lib: { entry, name: "SonnerLayoutFixture", formats: ["iife"], fileName: "fixture.js" },
    },
    logLevel: "error",
  });
  const bundleName = fs.readdirSync(dir).find((name) =>
    name.startsWith("fixture.js") && name.endsWith(".js"),
  );
  if (!bundleName) throw new Error("Sonner fixture bundle was not written");

  const source = fs.readFileSync(path.join(root, "components/ui/sonner.tsx"), "utf8");
  const candidates = new Set<string>();
  for (const match of source.matchAll(/"([^"\n]+)"/g)) {
    for (const token of match[1].split(/\s+/)) candidates.add(token);
  }
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
      return { path: file, base: path.dirname(file), content: fs.readFileSync(file, "utf8") };
    },
  });
  fs.writeFileSync(path.join(dir, "fixture.css"), stripAppFontFaces(compiler.build([...candidates])));
  for (const fixtureTheme of ["light", "dark"] as const) {
    fs.writeFileSync(
      path.join(dir, `fixture-${fixtureTheme}.html`),
      `<!doctype html><html data-theme="${fixtureTheme}" class="${fixtureTheme === "dark" ? "dark" : ""}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${productFontStyle()}</style><link rel="stylesheet" href="fixture.css"></head><body><div id="root"></div><script src="${bundleName}"></script></body></html>`,
    );
  }
  fixtureDir = dir;
  return pathToFileURL(path.join(dir, `fixture-${theme}.html`)).href;
}

function contrastRatio(foreground: string, background: string): number {
  const luminance = (color: string) => {
    const values = color.match(/[\d.]+/g)?.slice(0, 3).map(Number);
    if (!values || values.length !== 3) throw new Error(`Unexpected color: ${color}`);
    const [red, green, blue] = values.map((value) => {
      const channel = value / 255;
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return red * 0.2126 + green * 0.7152 + blue * 0.0722;
  };
  const [light, dark] = [luminance(foreground), luminance(background)].sort(
    (left, right) => right - left,
  );
  return (light + 0.05) / (dark + 0.05);
}

for (const theme of ["light", "dark"] as const) {
  for (const width of [320, 1440] as const) {
    test(`Sonner success and error are usable in ${theme} at ${width}px`, async ({ page }) => {
      // The first case also bundles React/Sonner and loads a fresh local file.
      // Give that setup its own budget; keep the toast assertions at 5 seconds.
      test.setTimeout(60_000);
      const startupErrors: string[] = [];
      page.on("pageerror", (error) => startupErrors.push(error.message));
      await page.setViewportSize({ width, height: 844 });
      await page.goto(await buildFixture(theme));
      // The mount starts empty, so explicitly request the face before the
      // shared fixture guard checks it. Otherwise the browser can leave the
      // registered face unloaded until the first toast is shown.
      await page.evaluate(() => document.fonts.load('16px "DMSansVariable"'));
      await awaitProductFont(page);
      await expect.poll(async () => ({
        ready: await page.evaluate(() => typeof (window as Window & { showFixtureToast?: unknown }).showFixtureToast),
        errors: startupErrors,
      }), { timeout: 20_000 }).toEqual({ ready: "function", errors: [] });

      for (const kind of ["success", "error"] as const) {
        await page.evaluate((nextKind) => {
          (window as Window & { showFixtureToast: (kind: "success" | "error") => void }).showFixtureToast(nextKind);
        }, kind);
        const toast = page.locator(`[data-sonner-toast][data-type="${kind}"]`).last();
        await expect(toast).toBeVisible();
        await expect.poll(() => toast.evaluate((node) => {
          const box = node.getBoundingClientRect();
          return box.top >= 0 && Number.parseFloat(getComputedStyle(node).opacity) >= 0.99;
        })).toBe(true);
        const state = await toast.evaluate((node) => {
          const title = node.querySelector<HTMLElement>("[data-title]")!;
          const action = node.querySelector<HTMLElement>("[data-button]")!;
          const close = node.querySelector<HTMLElement>("[data-close-button]")!;
          const toastRect = node.getBoundingClientRect();
          const actionRect = action.getBoundingClientRect();
          const closeRect = close.getBoundingClientRect();
          return {
            left: toastRect.left,
            right: toastRect.right,
            actionHeight: actionRect.height,
            actionWidth: actionRect.width,
            closeHeight: closeRect.height,
            closeWidth: closeRect.width,
            titleHeight: title.getBoundingClientRect().height,
            titleFont: getComputedStyle(title).fontFamily,
            foreground: getComputedStyle(title).color,
            background: getComputedStyle(node).backgroundColor,
            actionForeground: getComputedStyle(action).color,
            actionBackground: getComputedStyle(action).backgroundColor,
            pageWidth: document.documentElement.scrollWidth,
          };
        });
        expect(state.left).toBeGreaterThanOrEqual(0);
        expect(state.right).toBeLessThanOrEqual(width + 1);
        expect(state.pageWidth).toBeLessThanOrEqual(width + 1);
        expect(state.titleFont).toContain("DMSansVariable");
        expect(state.titleHeight).toBeLessThanOrEqual(41);
        expect(contrastRatio(state.foreground, state.background)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(state.actionForeground, state.actionBackground)).toBeGreaterThanOrEqual(4.5);
        // Transformed Sonner layers can round a 44px CSS box to 43.99999px.
        expect(state.actionHeight).toBeGreaterThanOrEqual(43.95);
        expect(state.actionWidth).toBeGreaterThanOrEqual(43.95);
        expect(state.closeHeight).toBeGreaterThanOrEqual(43.95);
        expect(state.closeWidth).toBeGreaterThanOrEqual(43.95);
        if (kind === "success") {
          if (process.env.ONE_THEME_EVIDENCE_DIR) {
            fs.mkdirSync(process.env.ONE_THEME_EVIDENCE_DIR, { recursive: true });
            await page.screenshot({
              path: path.join(process.env.ONE_THEME_EVIDENCE_DIR, `sonner-${theme}-${width}.png`),
            });
          }
          await toast.locator("[data-button]").click();
          await expect.poll(() => page.evaluate(() => Boolean((window as Window & { toastActionClicked?: boolean }).toastActionClicked))).toBe(true);
        } else {
          await toast.locator("[data-close-button]").click();
          await expect(toast).not.toBeVisible();
        }
      }
    });
  }
}
