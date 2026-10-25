import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { awaitProductFont, productFontStyle, stripAppFontFaces } from "./fixtures/product-font";

// This source-coupled fixture compiles the app's full Tailwind sheet on an SSD.
test.setTimeout(120_000);

let css: string;
let script: string;
let outDir = "";
test.beforeAll(async () => {
  test.setTimeout(120_000);
  const root = process.cwd();
  const { build } = await import("vite");
  const { Scanner } = await import("@tailwindcss/oxide");
  const scanner = new Scanner({});
  const candidates = new Set<string>();
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-selection-"));
  await build({
    configFile: false,
    logLevel: "error",
    plugins: [
      {
        name: "fixture-css-candidates",
        transform(source, id) {
          if (!id.includes("node_modules") && /\.[tj]sx?$/.test(id)) {
            for (const candidate of scanner.scanFiles([
              { content: source, extension: "tsx" },
            ]))
              candidates.add(candidate);
          }
        },
      },
    ],
    // Match production React regardless of the parent process build mode.
    oxc: { jsx: { runtime: "automatic", development: false } },
    resolve: { alias: [
      ...["@/hooks/use-auth", "@/lib/services/api-service", "@/lib/services/personal-knowledge-model-service", "@/lib/services/vault-service", "@/lib/morphy-ux/morphy", "@/lib/services/kai-profile-service", "next/navigation", "next/image", "@/lib/firebase/auth-context", "@/lib/vault/vault-context", "@/components/vault/vault-unlock-dialog", "@/components/app-ui/native-test-beacon", "@/lib/services/pre-vault-user-state-service", "@/lib/services/initial-contacts-onboarding-service", "@/lib/services/cache-service", "@/lib/services/one-setup-exit-service", "@/lib/services/pre-vault-sensitive-draft-service", "@/lib/services/finance-setup-draft-service", "@/lib/services/post-unlock-sync-service", "@/lib/connections/gemini-runtime-configuration", "@/lib/agent/one-conversation-session", "@/lib/kai/actions/voice-surface-metadata", "@/lib/agent/local-onboarding-actions"].map(find => ({ find, replacement: path.join(root, "e2e/fixtures/ai-selection-boundaries.tsx") })),
      { find: "@", replacement: root },
    ] },
    define: {
      "process.env.NODE_ENV": JSON.stringify("production"),
      "process.env": "{}",
    },
    build: {
      outDir,
      emptyOutDir: false,
      lib: {
        entry: path.join(root, "e2e/fixtures/ai-selection.tsx"),
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
  css = stripAppFontFaces(compiler.build([...candidates])) + productFontStyle() + fs.readdirSync(outDir).filter((name) => name.endsWith(".css")).map((name) => fs.readFileSync(path.join(outDir, name), "utf8")).join("\n");
});

test.afterAll(() => {
  if (outDir) fs.rmSync(outDir, { recursive: true, force: true });
});

for (const viewport of [
  {width:320,height:568}, {width:390,height:844},
  {width:800,height:600}, {width:1440,height:900},
]) {
  for (const theme of ["light", "dark"]) {
    test(`AI selection ${viewport.width}x${viewport.height} ${theme}`, async ({page}, testInfo) => {
      await page.setViewportSize(viewport);
      await page.route("http://fixture.local/brand/providers/**", async (route) => {
        const filename = path.basename(new URL(route.request().url()).pathname);
        await route.fulfill({contentType:"image/svg+xml", body:fs.readFileSync(path.join(process.cwd(),"public/brand/providers",filename))});
      });
      await page.route("http://fixture.local/onboarding/intro-v2/**", async (route) => {
        const filename = path.basename(new URL(route.request().url()).pathname);
        await route.fulfill({path:path.join(process.cwd(),"public/onboarding/intro-v2",filename)});
      });
      await page.setContent(`<html class="${theme === "dark" ? "dark" : ""}"><head><meta name="viewport" content="width=device-width, initial-scale=1"><base href="http://fixture.local/"><style>${css}</style></head><body><div id="root"></div></body></html>`);
      await page.addStyleTag({ content: ":root { --app-safe-area-top-effective: 0px; --app-safe-area-bottom-effective: 0px; }" });
      await page.addScriptTag({content:script});
      await expect(page.getByRole("heading", { name: "Choose your AI" })).toBeVisible();
      await awaitProductFont(page);
      const next = page.getByRole("button", { name: "Continue", exact: true });
      const card = page.getByTestId("profile-gemini-runtime");
      await expect(card.getByText("Bring your own AI", { exact: true })).toBeVisible();
      await expect(card.getByText("Use Hussh AI", { exact: true })).toBeVisible();
      await expect(card.locator('[data-slot="settings-row-title"]').filter({ hasText: /^Gemini$/ })).toBeVisible();
      await expect(page.locator('[data-slot="settings-row-title"]').filter({ hasText: /^OpenAI$/ })).toBeVisible();
      await expect(page.locator('[data-slot="settings-row-title"]').filter({ hasText: /^Azure AI key$/ })).toBeVisible();
      await expect(next).toBeDisabled();
      const radios = page.getByRole("radio");
      await expect(radios).toHaveCount(2);
      await expect(radios.nth(0)).not.toBeChecked();
      await radios.nth(0).click();
      await expect(radios.nth(0)).toBeChecked();
      await expect(next).toBeEnabled();
      // Editing another connection must not imply a validated credential.
      const change = page.getByRole("button", { name: "Change AI", exact: true });
      if (await change.isVisible()) await change.click();
      await radios.nth(1).click();
      await expect(next).toBeDisabled();
      await page.getByRole("button", { name: "Validate key", exact: true }).click();
      await expect(page.getByRole("alert")).toHaveText("Enter your Gemini API key.");
      const input = page.getByLabel("Gemini API key");
      await input.fill("fixture-invalid");
      await page.getByRole("button", { name: "Validate key", exact: true }).click();
      await expect(page.getByRole("alert")).toHaveText("This key could not be validated.");
      await expect(next).toBeDisabled();
      await input.fill("fixture-valid");
      // A raised keyboard reduces the available viewport; both credential and
      // completion controls must remain reachable through the page's own scroll.
      if (viewport.width < 900) {
        await page.setViewportSize({ width: viewport.width, height: Math.max(280, viewport.height - 300) });
      }
      await input.focus();
      await input.scrollIntoViewIfNeeded();
      await expect(input).toBeInViewport();
      await page.getByRole("button", { name: "Validate key", exact: true }).click();
      await page.getByRole("button", { name: "Confirm and save", exact: true }).click();
      await expect(next).toBeEnabled();
      await next.scrollIntoViewIfNeeded();
      await expect(next).toBeInViewport();
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
      await page.setViewportSize(viewport);
      await page.screenshot({ path: testInfo.outputPath("ai-selection.png") });
      await next.click();
      await expect(page.locator("body")).toHaveAttribute("data-destination", "/one/setup");
      await expect(page.getByText("Set a lock")).toHaveCount(0);
    });
  }
}
