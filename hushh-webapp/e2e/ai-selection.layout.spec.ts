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
      const surface = page.locator('[data-setup-v10-stage="ai"]');
      const scene = surface.locator('img[src$="working-poster.png"]');
      await expect(scene).toHaveJSProperty("naturalWidth", 512);
      const next = page.getByRole("button", { name:"Continue", exact:true });
      await expect(next).toBeDisabled();
      await expect(next).toHaveCSS("opacity", "1");
      await expect(page.getByRole("heading", { name:"Coming soon", exact:true })).toHaveCount(1);
      await expect(page.getByText("Available now", { exact:true })).toBeVisible();
      await expect(page.getByText("Pick one to continue.")).toHaveCount(0);
      const radios = page.getByRole("radio");
      await expect(radios).toHaveCount(2);
      await expect(radios.nth(0)).not.toBeChecked();
      const card = page.getByTestId("profile-gemini-runtime");
      await expect(card.locator('[data-slot="settings-row-title"]').first()).toHaveCSS("font-size", "15px");
      await expect(card.locator('[data-slot="settings-row-description"]').first()).toHaveCSS("font-size", "12px");
      const box = (await card.boundingBox())!;
      const buttonBox = (await next.boundingBox())!;
      expect(buttonBox.width).toBeCloseTo(box.width, 0);
      expect(buttonBox.x + buttonBox.width / 2).toBeCloseTo(box.x + box.width / 2, 0);
      const upcoming = page.getByTestId("setup-coming-soon-runtime");
      const upcomingBox = (await upcoming.boundingBox())!;
      expect(upcomingBox.y - box.y - box.height).toBeGreaterThanOrEqual(10);
      expect(upcomingBox.x).toBeCloseTo(box.x,0);
      expect(upcomingBox.width).toBeCloseTo(box.width,0);
      expect(buttonBox.y).toBeGreaterThan(upcomingBox.y + upcomingBox.height);
      const artBox = (await scene.boundingBox())!;
      const heading = page.getByRole("heading", {name:"Choose your AI"});
      await expect(heading).toHaveCSS("font-size", viewport.width >= 900 ? "43px" : viewport.height <= 700 ? "27px" : "30px");
      const headingBox = (await heading.boundingBox())!;
      if (viewport.width >= 900) expect(artBox.x + artBox.width).toBeLessThan(headingBox.x);
      else expect(artBox.y + artBox.height).toBeLessThan(headingBox.y);
      await expect(upcoming.locator("li")).toHaveCount(4);
      await expect(upcoming.locator("button, input, [role=radio]")).toHaveCount(0);
      await expect(upcoming.getByRole("heading")).toHaveCSS("font-size","12px");
      for (const item of await upcoming.locator("li").all()) {
        await expect(item).toHaveCSS("font-size","12px");
        await expect(item.getByRole("img")).toBeHidden();
      }
      await page.screenshot({path:testInfo.outputPath("upcoming-providers.png")});
      await expect(page.getByText("Use ours, or bring your own key.")).toHaveCSS("font-size", viewport.width >= 900 ? "16px" : "14px");
      await expect(next).toHaveCSS("height", "52px");
      await radios.nth(0).click();
      await expect(radios.nth(0)).toBeChecked();
      await expect(next).toBeEnabled();
      await expect(next).toHaveCSS("background-color", "rgb(0, 113, 227)");
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
      if (viewport.width < 900) {
        await page.evaluate(() => {
          const root = document.documentElement;
          root.classList.add("native-keyboard-inset", "kb-open");
          root.style.setProperty("--kb-height", "300px");
        });
        await expect(surface).toHaveCSS("overflow-y", "auto");
        const visibleHeight = await surface.evaluate(el => el.getBoundingClientRect().height);
        expect(visibleHeight).toBeLessThanOrEqual(viewport.height - 299);
        const keyInput = page.getByLabel("Gemini API key");
        await expect(keyInput).toHaveCSS("font-size", "16px");
        await keyInput.focus();
        await keyInput.scrollIntoViewIfNeeded();
        const inputBox = (await keyInput.boundingBox())!;
        const surfaceBox = (await surface.boundingBox())!;
        expect(inputBox.y + inputBox.height).toBeLessThanOrEqual(surfaceBox.y + surfaceBox.height + 1);
        await next.scrollIntoViewIfNeeded();
        const raisedButton = (await next.boundingBox())!;
        expect(raisedButton.y + raisedButton.height).toBeLessThanOrEqual(surfaceBox.y + surfaceBox.height + 1);
        await page.screenshot({path:testInfo.outputPath("ai-keyboard.png")});
        await page.evaluate(() => {
          document.documentElement.classList.remove("native-keyboard-inset", "kb-open");
          document.documentElement.style.removeProperty("--kb-height");
        });
        await page.evaluate(() => {
          const root = document.documentElement;
          root.classList.add("kb-open");
          root.style.setProperty("--kb-height", "300px");
          root.style.setProperty("--kb-visible-height", `${window.innerHeight - 300}px`);
        });
        const webHeight = await surface.evaluate(el => el.getBoundingClientRect().height);
        expect(webHeight).toBeLessThanOrEqual(viewport.height - 299);
        await page.getByLabel("Gemini API key").scrollIntoViewIfNeeded();
        const webInput = (await page.getByLabel("Gemini API key").boundingBox())!;
        const webSurface = (await surface.boundingBox())!;
        expect(webInput.y + webInput.height).toBeLessThanOrEqual(webSurface.y + webSurface.height + 1);
        await page.evaluate(() => {
          document.documentElement.classList.remove("kb-open");
          document.documentElement.style.removeProperty("--kb-height");
          document.documentElement.style.removeProperty("--kb-visible-height");
        });
      }
      await page.getByRole("button",{name:"Validate key",exact:true}).click();
      await page.getByRole("button",{name:"Confirm and save",exact:true}).click();
      await expect(next).toBeEnabled();
      await expect(next).toHaveCSS("background-color", "rgb(0, 113, 227)");
      await expect(page.getByText("Your key is validated. Continue to finish setup.")).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth-innerWidth)).toBeLessThanOrEqual(1);
      await page.screenshot({path:testInfo.outputPath("ai-selection.png")});
      await next.click();
      await expect(page.getByText("Set a lock")).toBeVisible();
    });
  }
}
