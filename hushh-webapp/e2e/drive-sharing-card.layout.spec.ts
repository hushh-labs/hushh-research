import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  awaitProductFont,
  productFontStyle,
  stripAppFontFaces,
} from "./fixtures/product-font";
let script: string;
let css: string;
test.beforeEach(async ({ page }) => {
  await page.route("**/api/connectors", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        connectors: [],
        features: { drive_document_sharing: true },
      }),
    }),
  );
});
test.beforeAll(async () => {
  const root = process.cwd();
  const { build } = await import("vite");
  const { Scanner } = await import("@tailwindcss/oxide");
  const scanner = new Scanner({});
  const candidates = new Set<string>();
  const outDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "drive-sharing-card-"),
  );
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
          "@/hooks/use-auth",
          "@/lib/vault/vault-context",
          "@/lib/services/api-service",
          "@/lib/services/auth-service",
          "@/lib/cache/cache-sync-service",
          "next/link",
        ].map((find) => ({
          find,
          replacement: path.join(
            root,
            "e2e/fixtures/document-share-boundaries.tsx",
          ),
        })),
        ...[
          "@/lib/agent/agent-pkm-memory",
          "@/lib/agent/agent-pkm-context-store",
          "@/lib/profile/pkm-agent-lab-capture",
          "@/lib/pkm/pkm-natural-language-ingestion",
        ].map(find => ({ find, replacement: path.join(root, "e2e/fixtures/drive-memory-boundaries.ts") })),
        { find: "@", replacement: root },
      ],
    },
    define: {
      "process.env.NODE_ENV": JSON.stringify("production"),
      "process.env.NEXT_PUBLIC_FIREBASE_API_KEY": JSON.stringify("test-api-key"),
      "process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN": JSON.stringify("fixture.firebaseapp.com"),
      "process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID": JSON.stringify("fixture"),
      "process.env.NEXT_PUBLIC_FIREBASE_APP_ID": JSON.stringify("1:123:web:fixture"),
      "process.env": "{}",
    },
    build: {
      outDir,
      emptyOutDir: false,
      lib: {
        entry: path.join(root, "e2e/fixtures/drive-sharing-card.tsx"),
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
  css = stripAppFontFaces(compiler.build([...candidates])) + productFontStyle();
});

function share(active = false) {
  return {
    shareId: "22222222-2222-4222-8222-222222222222", searchJobId: "11111111-1111-4111-8111-111111111111",
    status: active ? "running" : "partial", revision: 1, reviewDigest: "a".repeat(64), fileCount: 72, recipientCount: 1,
    recipients: [{ name: "Alex", email: "alex@example.com" }], excluded: [],
    counts: active ? { total: 72, processed: 3, shared: 3, alreadyShared: 0, skipped: 0, failed: 0, needsReview: 0, unknown: 0, pending: 69 } :
      { total: 72, processed: 72, shared: 62, alreadyShared: 9, skipped: 1, failed: 0, needsReview: 0, unknown: 0, pending: 0 },
    issues: active ? [] : [{ reasonCode: "provider_unavailable", count: 1 }],
    notifications: { settled: 1, pending: 0, unavailable: 0 }, canApprove: false, canStop: active,
    canRetry: !active, retryableCount: active ? 0 : 1,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  };
}
async function mount(page: Page, dark: boolean, active = false, sidebar = false) {
  const mutations: string[] = [];
  const runtimeErrors: string[] = [];
  page.on("pageerror", error => runtimeErrors.push(error.message));
  await page.route("http://localhost/drive-card.js", route => route.fulfill({ contentType: "application/javascript", body: script }));
  await page.route("http://localhost/drive-card-fixture**", route => route.fulfill({ contentType: "text/html",
    body: `<!doctype html><html class="${dark ? "dark" : ""}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div><script src="/drive-card.js"></script></body></html>` }));
  await page.route("**/icons/connectors/drive.svg", route => route.fulfill({ contentType: "image/svg+xml",
    body: fs.readFileSync(path.join(process.cwd(), "public/icons/connectors/drive.svg"), "utf8") }));
  await page.route("**/api/connectors/google_drive/sharing/bulk**", route => {
    const pathname = new URL(route.request().url()).pathname;
    let result = share(active);
    if (route.request().method() === "POST") {
      mutations.push(pathname);
      if (pathname.endsWith("/stop")) result = { ...result, status: "stopped", revision: 2, canStop: false,
        counts: { ...result.counts, processed: 72, pending: 0, skipped: 69 } };
    }
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(pathname.endsWith("/bulk") ? { shares: [result] } : result) });
  });
  await page.goto(`http://localhost/drive-card-fixture${sidebar ? "?sidebar=1" : ""}`);
  await awaitProductFont(page);
  await expect(sidebar ? page.getByRole("region", { name: "Drive sharing activity" }) :
    page.getByRole("region", { name: "Drive sharing", exact: true }), runtimeErrors.join("; ")).toBeVisible();
  return mutations;
}

for (const [width, dark] of [[390, false], [1440, true]] as const)
  test(`Drive updates stay in the left chat bar at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 850 });
    const mutations = await mount(page, dark, false, true);
    const sidebar = page.locator("[data-test-drive-sidebar]");
    const row = sidebar.getByRole("button", { name: "Needs attention. 71 of 72 available. View details" });
    await expect(row).toBeVisible();
    await expect(page.getByRole("region", { name: "Drive sharing", exact: true })).toHaveCount(0);
    const sidebarBox = (await sidebar.boundingBox())!;
    const rowBox = (await row.boundingBox())!;
    expect(rowBox.x).toBeGreaterThanOrEqual(sidebarBox.x);
    expect(rowBox.x + rowBox.width).toBeLessThanOrEqual(sidebarBox.x + sidebarBox.width);
    await page.screenshot({ path: testInfo.outputPath("drive-sidebar.png"), fullPage: false });
    await row.click();
    const dialog = page.getByRole("dialog", { name: "Drive sharing" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("71 of 72 files available");
    await expect(dialog).toContainText("Google Drive was unavailable");
    await expect(dialog.getByRole("button", { name: "Close Drive sharing card" })).toHaveCount(0);
    const dialogBox = (await dialog.boundingBox())!;
    expect(dialogBox.x).toBeGreaterThanOrEqual(0);
    expect(dialogBox.x + dialogBox.width).toBeLessThanOrEqual(width);
    await page.screenshot({ path: testInfo.outputPath("drive-sidebar-details.png"), fullPage: false });
    await dialog.getByRole("button", { name: "Hide this update" }).click();
    await expect(row).toHaveCount(0);
    await expect(sidebar.getByRole("textbox", { name: "Search chats" })).toBeFocused();
    expect(mutations).toEqual([]);
  });

for (const width of [375, 430, 1440]) for (const dark of [false, true])
  test(`Drive sharing is compact, readable and dismissible at ${width}px in ${dark ? "dark" : "light"}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 850 });
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    const mutations = await mount(page, dark);
    const card = page.getByRole("region", { name: "Drive sharing", exact: true });
    await expect(card).toContainText("71 of 72 files available");
    await expect(card).toContainText("Google Drive was unavailable");
    await expect(card).not.toContainText(/Notifications:|0 failed|file access checks/);
    const box = (await card.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(width);
    expect(box.height).toBeLessThan(340);
    for (const button of await card.getByRole("button").all()) {
      const bounds = (await button.boundingBox())!;
      expect(bounds.height).toBeGreaterThanOrEqual(44); expect(bounds.width).toBeGreaterThanOrEqual(44);
    }
    const close = card.getByRole("button", { name: "Close Drive sharing card" });
    expect(await close.evaluate(element => getComputedStyle(element).color)).toBe(await close.evaluate(element => {
      const probe = document.createElement("span"); probe.style.color = "var(--destructive)"; element.append(probe);
      const value = getComputedStyle(probe).color; probe.remove(); return value;
    }));
    expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
    const contrast = await card.evaluate(element => {
      const canvas = document.createElement("canvas"); canvas.width = 1; canvas.height = 1;
      const context = canvas.getContext("2d")!;
      const luminance = (rgb: Uint8ClampedArray) => [...rgb].slice(0, 3).map(value => {
        const channel = value / 255; return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
      }).reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
      return [...element.querySelectorAll("p, summary, button")].map(text => {
        context.fillStyle = "white"; context.fillRect(0, 0, 1, 1);
        const ancestors: Element[] = []; for (let node: Element | null = text; node; node = node.parentElement) ancestors.unshift(node);
        for (const node of ancestors) { context.fillStyle = getComputedStyle(node).backgroundColor; context.fillRect(0, 0, 1, 1); }
        const background = luminance(context.getImageData(0, 0, 1, 1).data);
        context.fillStyle = getComputedStyle(text).color; context.fillRect(0, 0, 1, 1);
        const foreground = luminance(context.getImageData(0, 0, 1, 1).data);
        return { label: text.getAttribute("aria-label") || text.textContent, ratio: (Math.max(background, foreground) + 0.05) / (Math.min(background, foreground) + 0.05) };
      });
    });
    for (const sample of contrast) expect(sample.ratio, sample.label || "text contrast").toBeGreaterThanOrEqual(sample.label === "Close Drive sharing card" ? 3 : 4.5);
    await page.screenshot({ path: testInfo.outputPath("drive-sharing.png"), fullPage: true });
    const draft = page.getByRole("textbox", { name: "Chat draft" }); await draft.fill("Keep my draft");
    await close.click();
    await expect(card).toHaveCount(0); await expect(draft).toHaveValue("Keep my draft"); await expect(draft).toBeFocused();
    await expect.poll(() => page.evaluate(() => localStorage.length)).toBe(1);
    expect(mutations).toEqual([]);
    await page.reload(); await awaitProductFont(page);
    await expect(page.getByRole("button", { name: "Save to memory" })).toBeVisible();
    await expect(card).toHaveCount(0); expect(errors).toEqual([]);
  });

test("Stop remaining is separate from Close, and reviewed notes require explicit Save", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 850 });
  const mutations = await mount(page, false, true);
  await page.getByRole("button", { name: "Stop remaining" }).click();
  await expect(page.getByText("Sharing stopped", { exact: true })).toBeVisible();
  expect(mutations).toEqual(["/api/connectors/google_drive/sharing/bulk/22222222-2222-4222-8222-222222222222/stop"]);
  await expect(page.getByRole("button", { name: "Close Drive sharing card" })).toBeEnabled();
  await expect(page.getByRole("status", { name: "Saved note count" })).toHaveText("0");
  await page.getByRole("button", { name: "Save to memory" }).click();
  await expect(page.getByText("The SDK launch is planned for October.", { exact: true })).toBeVisible();
  await expect(page.getByRole("status", { name: "Saved note count" })).toHaveText("0");
  await page.getByRole("checkbox", { name: "Keep: Priya owns the SDK launch." }).uncheck();
  await page.getByRole("button", { name: "Save 1 of 2" }).click();
  await expect(page.getByText("1 note saved to memory.", { exact: true })).toBeVisible();
  await expect(page.getByRole("status", { name: "Saved note count" })).toHaveText("1");
});
