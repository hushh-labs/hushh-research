import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { awaitProductFont, productFontStyle, stripAppFontFaces } from "./fixtures/product-font";

let css: string;
let script: string;
let outDir: string;

test.beforeAll(async () => {
  const root = process.cwd();
  const { build } = await import("vite");
  const { Scanner } = await import("@tailwindcss/oxide");
  const scanner = new Scanner({});
  const candidates = new Set<string>();
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), "setup-hub-"));
  await build({
    configFile: false,
    logLevel: "error",
    plugins: [{
      name: "fixture-css-candidates",
      transform(source, id) {
        if (!id.includes("node_modules") && /\.[tj]sx?$/.test(id)) {
          for (const candidate of scanner.scanFiles([{ content: source, extension: "tsx" }])) candidates.add(candidate);
        }
      },
    }],
    oxc: { jsx: { runtime: "automatic", development: false } },
    resolve: { alias: [
      ...["@/lib/services/kai-profile-service", "next/navigation", "next/image", "@/lib/firebase/auth-context", "@/lib/vault/vault-context", "@/components/vault/vault-unlock-dialog", "@/components/app-ui/native-test-beacon", "@/components/onboarding/initial-contacts-bridge", "@/lib/services/initial-contacts-onboarding-service", "@/lib/services/pre-vault-user-state-service", "@/lib/services/cache-service", "@/lib/services/one-setup-exit-service", "@/lib/services/pre-vault-sensitive-draft-service", "@/lib/services/finance-setup-draft-service", "@/lib/services/post-unlock-sync-service", "@/lib/connections/gemini-runtime-configuration", "@/lib/agent/one-conversation-session", "@/lib/kai/actions/voice-surface-metadata", "@/lib/agent/local-onboarding-actions"].map(find => ({ find, replacement: path.join(root, "e2e/fixtures/setup-hub-boundaries.tsx") })),
      { find: "@", replacement: root },
    ] },
    define: { "process.env.NODE_ENV": JSON.stringify("production"), "process.env": "{}" },
    build: {
      outDir,
      emptyOutDir: false,
      lib: {
        entry: path.join(root, "e2e/fixtures/setup-hub.tsx"),
        name: "Fixture",
        formats: ["iife"],
        fileName: () => "fixture.js",
      },
    },
  });
  script = fs.readFileSync(path.join(outDir, "fixture.js"), "utf8");
  const { compile } = await import("tailwindcss");
  const compiler = await compile(
    fs.readFileSync(path.join(root, "app/globals.css"), "utf8")
      .replace(/^@source\s+[^;]+;\s*$/gm, ""),
    {
      base: path.join(root, "app"),
      loadStylesheet: async (id, base) => {
        const file = id === "tailwindcss"
          ? path.join(root, "node_modules/tailwindcss/index.css")
          : id === "tw-animate-css"
            ? path.join(root, "node_modules/tw-animate-css/dist/tw-animate.css")
            : path.resolve(base, id);
        return { path: file, base: path.dirname(file), content: fs.readFileSync(file, "utf8") };
      },
    },
  );
  css = stripAppFontFaces(compiler.build([...candidates])) + productFontStyle()
    + fs.readdirSync(outDir).filter(name => name.endsWith(".css"))
      .map(name => fs.readFileSync(path.join(outDir, name), "utf8")).join("\n");
});

test.afterAll(() => {
  if (outDir) fs.rmSync(outDir, { recursive: true, force: true });
});

for (const viewport of [
  { width: 320, height: 568 },
  { width: 390, height: 844 },
  { width: 800, height: 600 },
  { width: 1440, height: 900 },
]) {
  for (const theme of ["light", "dark"]) {
    test(`Setup V10 hub ${viewport.width}×${viewport.height} ${theme}`, async ({ page }, testInfo) => {
      await page.setViewportSize(viewport);
      await page.route("http://setup.local/onboarding/intro-v2/*", async route => {
        const name = path.basename(new URL(route.request().url()).pathname);
        await route.fulfill({
          body: fs.readFileSync(path.join(process.cwd(), "public/onboarding/intro-v2", name)),
          contentType: "image/png",
        });
      });
      await page.setContent(`<html class="${theme === "dark" ? "dark" : ""}"><head><base href="http://setup.local/"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><style>${css}</style></head><body><div id="root"></div></body></html>`);
      await page.addScriptTag({ content: script });
      await awaitProductFont(page);

      const surface = page.locator('[data-setup-v10-stage="hub"]');
      const art = page.locator("[data-setup-v10-art]");
      const content = page.locator("[data-setup-v10-content]");
      const heading = page.getByRole("heading", { name: "Set up One" });
      const subtitle = page.getByText("Choose the AI that works for you.", { exact: true });
      const choice = page.getByTestId("one-setup-ai-choice");
      const finish = page.getByTestId("one-setup-master-ack");
      await expect(surface).toBeVisible();
      await expect(heading).toBeVisible();
      await expect(subtitle).toBeVisible();
      await expect(choice).toBeVisible();
      await expect(finish).toBeDisabled();
      await expect(page.locator('img[src="/onboarding/intro-v2/answering-poster.png"]')).toBeVisible();
      await expect(heading).toHaveCSS("font-weight", "600");
      await expect(heading).toHaveCSS("font-family", /Plus Jakarta Sans/);
      await expect(surface).toHaveCSS("background-color", theme === "dark" ? "rgb(16, 17, 20)" : "rgb(255, 255, 255)");

      const artBox = (await art.boundingBox())!;
      const contentBox = (await content.boundingBox())!;
      if (viewport.width < 900) {
        expect(artBox.y + artBox.height).toBeLessThanOrEqual(contentBox.y + 1);
      } else {
        expect(artBox.x + artBox.width).toBeLessThanOrEqual(contentBox.x + 1);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
      await page.screenshot({ path: testInfo.outputPath("setup-required.png") });
      await finish.scrollIntoViewIfNeeded();
      await expect(finish).toBeInViewport();

      await page.evaluate(() => window.dispatchEvent(new Event("fixture:ai-choice-saved")));
      await expect(finish).toBeEnabled();
      await expect(choice.getByText("Selected", { exact: true })).toBeVisible();
      await expect(page.getByTestId("pwm-research-disclosure")).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath("setup-selected.png") });
    });
  }
}
