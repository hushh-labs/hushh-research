import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  awaitProductFont,
  productFontStyle,
  stripAppFontFaces,
} from "./fixtures/product-font";

/** Production Connect page against synthetic identity/network boundaries. */

const WIDTHS = [320, 375, 393, 430, 768, 1440] as const;

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

async function settle(page: Page) {
  const group = page.getByTestId("connect-my-connections-group");
  // The page bundle is large; its first commit can take a few seconds under
  // parallel workers before the timed network even starts.
  await expect(group.locator("[data-voice-label]")).toHaveCount(6, { timeout: 30_000 });
  await expect(page.getByTestId("connect-directory-group").getByText("Avery Stone")).toBeVisible();
  await expect(page.getByRole("tab", { name: "Connections", exact: true })).toHaveAttribute("aria-selected", "true");
  // Circle discovery belongs to Circles, never the Connections panel.
  await expect(page.getByRole("button", { name: /Your Trusted Circle/ })).toBeHidden();
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

for (const dark of [false, true]) {
  for (const width of WIDTHS) {
    test(`Stitch Connect cards preserve actions at ${width}px ${dark ? "dark" : "light"}`, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await open(page, width, dark);
      await settle(page);
      const cards = page.getByTestId("directory-person-card");
      await expect(cards).toHaveCount(3);
      await expect(cards.first()).toContainText("p***0@example.com");
      await expect(cards.first().getByText("Alex Chen", { exact: true })).toHaveCount(0);
      await expect(cards.first()).toContainText("2 mutual connections");
      const mutual = cards.first().getByRole("button", { name: "Open mutual connection Alex Chen's profile" });
      await mutual.click();
      await expect(page.locator("body")).toHaveAttribute("data-last-navigation", /^\/people\/person_alex\?/);
      await expect(cards.nth(1).getByTestId("mutual-connection")).toHaveCount(0);
      await page.getByRole("tab", { name: "Circles", exact: true }).click();
      await expect(page.getByRole("tab", { name: "Circles", exact: true })).toHaveAttribute("aria-selected", "true");
      if (width >= 640)
        await expect(page.getByRole("button", { name: /Your Trusted Circle/ })).toBeVisible();
      await page.getByRole("button", { name: "Create your own circle" }).click();
      const createDialog = page.getByRole("dialog", { name: "Create a Circle" });
      await expect(createDialog).toBeVisible();
      await expect(createDialog.getByRole("textbox")).toBeVisible();
      const createBounds = await createDialog.boundingBox();
      expect(createBounds).not.toBeNull();
      expect(Math.abs(createBounds!.x + createBounds!.width / 2 - width / 2)).toBeLessThan(2);
      expect(createBounds!.x).toBeGreaterThanOrEqual(0);
      expect(createBounds!.x + createBounds!.width).toBeLessThanOrEqual(width);
      await createDialog.getByRole("button", { name: "Close", exact: true }).click();
      await expect(createDialog).toHaveCount(0);
      await page.getByRole("tab", { name: "Connections", exact: true }).click();
      await expect(page.getByRole("tab", { name: "Connections", exact: true })).toHaveAttribute("aria-selected", "true");
      // Unlike the initial loading state, the Circle card has now actually
      // been presented. Returning must remove its interaction/accessibility.
      await expect(page.getByRole("button", { name: /Your Trusted Circle/ })).toBeHidden();
      const circlesPanel = page.locator('[role="tabpanel"]').filter({ has: page.locator('[data-connect-surface="circles"]') });
      await expect(circlesPanel).toHaveAttribute("aria-hidden", "true");
      await expect(circlesPanel).toHaveAttribute("inert", "");
      const messageButtons = page.getByRole("button", { name: /^Message / });
      await expect(messageButtons).toHaveCount(6);
      await expect(messageButtons.first()).toBeEnabled();
      await messageButtons.first().click();
      await expect(page.locator("body")).toHaveAttribute(
        "data-last-navigation",
        "/one/messages?person=person_0",
      );
      const geometry = await cards.evaluateAll((nodes) => nodes.map((node) => {
        const r = node.getBoundingClientRect();
        return { left: r.left, top: r.top, right: r.right, width: r.width };
      }));
      expect(geometry.every((r) => r.left >= 0 && r.right <= width)).toBe(true);
      if (width >= 768) expect(new Set(geometry.map((r) => r.top)).size).toBe(1);
      else if (width >= 360) expect(geometry[0].top).toBe(geometry[1].top);
      else expect(geometry[1].top).toBeGreaterThan(geometry[0].top);
      await page.getByRole("button", { name: /Remove connection with Alex Chen/ }).click();
      const dialog = page.getByRole("alertdialog");
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole("button", { name: "Delete", exact: true })).toBeVisible();
      const bounds = await dialog.boundingBox();
      expect(bounds).not.toBeNull();
      expect(Math.abs(bounds!.x + bounds!.width / 2 - width / 2)).toBeLessThan(2);
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      await page.getByTestId("connect-my-connections-toggle").click();
      await expect(page.locator("#connect-my-connections-panel")).toBeHidden();
      await page.getByTestId("connect-my-connections-toggle").click();
      await expect(page.locator("#connect-my-connections-panel")).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
      expect(errors).toEqual([]);
      const shotDir = process.env.CONNECT_GRID_SHOT_DIR;
      if (shotDir && (width === 393 || width === 1440)) {
        fs.mkdirSync(shotDir, { recursive: true });
        await page.locator("[data-app-scroll-root]").evaluate((node) => { node.scrollTop = 0; });
        await page.screenshot({ path: path.join(shotDir, `connect-${width}-${dark ? "dark" : "light"}-top.png`) });
        await cards.first().scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(shotDir, `connect-${width}-${dark ? "dark" : "light"}-people.png`) });
      }
    });
  }
}
