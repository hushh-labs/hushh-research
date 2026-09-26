import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { awaitProductFont, productFontStyle, stripAppFontFaces } from "./fixtures/product-font";

let css: string;
let script: string;
test.beforeAll(async () => {
  const root = process.cwd();
  const { build } = await import("vite");
  const { Scanner } = await import("@tailwindcss/oxide");
  const scanner = new Scanner({});
  const candidates = new Set<string>();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-selection-"));
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
      ...["@/hooks/use-auth", "@/lib/services/api-service", "@/lib/services/personal-knowledge-model-service", "@/lib/services/vault-service", "@/lib/morphy-ux/morphy", "@/lib/services/kai-profile-service", "next/navigation", "next/image", "@/lib/firebase/auth-context", "@/lib/vault/vault-context", "@/components/vault/vault-unlock-dialog", "@/components/app-ui/native-test-beacon", "@/lib/services/pre-vault-user-state-service", "@/lib/services/cache-service", "@/lib/services/one-setup-exit-service", "@/lib/services/pre-vault-sensitive-draft-service", "@/lib/services/finance-setup-draft-service", "@/lib/services/post-unlock-sync-service", "@/lib/connections/gemini-runtime-configuration", "@/lib/agent/one-conversation-session", "@/lib/voice/voice-surface-metadata", "@/lib/agent/local-onboarding-actions"].map(find => ({ find, replacement: path.join(root, "e2e/fixtures/ai-selection-boundaries.tsx") })),
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

for (const width of [320, 393, 768, 1440]) {
  for (const theme of ["light", "dark"]) {
    test(`AI selection ${width}px ${theme}`, async ({page}, testInfo) => {
      await page.setViewportSize({width,height:852});
      await page.route("http://fixture.local/brand/providers/**", async (route) => {
        const filename = path.basename(new URL(route.request().url()).pathname);
        await route.fulfill({contentType:"image/svg+xml", body:fs.readFileSync(path.join(process.cwd(),"public/brand/providers",filename))});
      });
      await page.setContent(`<html class="${theme === "dark" ? "dark" : ""}"><head><base href="http://fixture.local/"><style>${css}</style></head><body><div id="root"></div></body></html>`);
      await page.addScriptTag({content:script});
      await expect(page.getByRole("heading", { name: "Choose your AI" })).toBeVisible();
      await awaitProductFont(page);
      const next = page.getByRole("button", { name:"Continue", exact:true });
      await expect(next).toBeDisabled();
      await expect(page.getByRole("heading", { name:"Coming soon", exact:true })).toHaveCount(1);
      await expect(page.getByText("Available now", { exact:true })).toHaveCount(0);
      await expect(page.getByText("Pick one to continue.")).toHaveCount(0);
      const radios = page.getByRole("radio");
      await expect(radios).toHaveCount(2);
      await expect(radios.nth(0)).not.toBeChecked();
      const card = page.getByTestId("profile-gemini-runtime");
      const box = (await card.boundingBox())!;
      const buttonBox = (await next.boundingBox())!;
      const upcoming = page.getByTestId("setup-coming-soon-runtime");
      const upcomingBox = (await upcoming.boundingBox())!;
      expect(upcomingBox.y - box.y - box.height).toBeCloseTo(24,0);
      expect(upcomingBox.x).toBeCloseTo(box.x,0);
      expect(upcomingBox.width).toBeCloseTo(box.width,0);
      expect(buttonBox.y - upcomingBox.y - upcomingBox.height).toBeCloseTo(16,0);
      await expect(upcoming.locator("li")).toHaveCount(4);
      await expect(upcoming.locator("button, input, [role=radio]")).toHaveCount(0);
      await expect(upcoming.getByRole("heading")).toHaveCSS("font-size","14px");
      await expect(upcoming.getByRole("heading")).toHaveCSS("font-weight","500");
      await expect(upcoming.locator("ul")).toHaveCSS("row-gap","12px");
      await expect(upcoming.locator("ul")).toHaveCSS("margin-top","12px");
      for (const item of await upcoming.locator("li").all()) {
        await expect(item).toHaveCSS("font-size","14px");
        await expect(item).toHaveCSS("column-gap","8px");
        await expect(item.getByRole("img")).toHaveCSS("width","20px");
        await expect(item.getByRole("img")).toHaveCSS("height","20px");
      }
      await expect.poll(() => page.locator("img").evaluateAll((images) => images.every((image) => (image as HTMLImageElement).naturalWidth > 0))).toBe(true);
      await page.screenshot({path:testInfo.outputPath("upcoming-providers.png")});
      await expect(page.locator('[data-slot="page-header-description"]')).toHaveCSS("font-size","13px");
      for (const property of ["height", "border-radius", "font-size", "font-weight", "background-color", "opacity"]) {
        const expected = await page.getByTestId("primary-reference").evaluate((el, prop) => getComputedStyle(el).getPropertyValue(prop),property);
        await expect(next).toHaveCSS(property,expected);
      }
      await radios.nth(0).click();
      await expect(radios.nth(0)).toBeChecked();
      await expect(next).toBeEnabled();
      await expect(page.getByText("Set a lock")).toHaveCount(0);
      await radios.nth(1).click();
      await expect(radios.nth(1)).toBeChecked();
      await expect(radios.nth(0)).not.toBeChecked();
      await expect(next).toBeDisabled();
      await page.getByRole("button",{name:"Validate key",exact:true}).click();
      await expect(page.getByRole("alert")).toHaveText("Enter your Gemini API key.");
      await page.getByLabel("Gemini API key").fill("fixture-invalid");
      await page.getByRole("button",{name:"Validate key",exact:true}).click();
      await expect(page.getByRole("alert")).toHaveText("This key could not be validated.");
      await expect(next).toBeDisabled();
      await page.getByLabel("Gemini API key").fill("fixture-valid");
      await page.getByRole("button",{name:"Validate key",exact:true}).click();
      await page.getByRole("button",{name:"Confirm and save",exact:true}).click();
      await expect(next).toBeEnabled();
      await expect(page.getByText("Your key is validated. Continue to finish setup.")).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth-innerWidth)).toBeLessThanOrEqual(1);
      await page.screenshot({path:testInfo.outputPath("ai-selection.png")});
      await next.click();
      await expect(page.getByText("Set a lock")).toBeVisible();
    });
  }
}
