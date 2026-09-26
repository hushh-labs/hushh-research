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
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "setup-hub-"));
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
      ...["@/lib/services/kai-profile-service", "next/navigation", "next/image", "@/lib/firebase/auth-context", "@/lib/vault/vault-context", "@/components/vault/vault-unlock-dialog", "@/components/app-ui/native-test-beacon", "@/lib/services/pre-vault-user-state-service", "@/lib/services/cache-service", "@/lib/services/one-setup-exit-service", "@/lib/services/pre-vault-sensitive-draft-service", "@/lib/services/finance-setup-draft-service", "@/lib/services/post-unlock-sync-service", "@/lib/connections/gemini-runtime-configuration", "@/lib/agent/one-conversation-session", "@/lib/voice/voice-surface-metadata", "@/lib/agent/local-onboarding-actions"].map(find => ({ find, replacement: path.join(root, "e2e/fixtures/setup-hub-boundaries.tsx") })),
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
    test(`Setup hub ${width}px ${theme}`, async ({page}, testInfo) => {
      await page.setViewportSize({width,height:852});
      await page.setContent(`<html class="${theme === "dark" ? "dark" : ""}"><head><style>${css}</style></head><body><div id="root"></div></body></html>`);
      await page.addScriptTag({content:script});
      const subtitle = page.locator('[data-slot="page-header-description"]');
      await expect(subtitle).toHaveText("Choose your AI first.");
      await awaitProductFont(page);
      const card = page.getByTestId("one-setup-ai-choice");
      const finish = page.getByRole("button", {name:"Finish setup",exact:true});
      await expect(finish).toBeDisabled();
      await expect(page.getByRole("progressbar")).toHaveCount(0);
      await expect(page.getByText("Remaining",{exact:true})).toHaveCount(0);
      await expect(page.getByText("Set up the rest later.",{exact:true})).toHaveCount(0);
      const subBox = (await subtitle.boundingBox())!;
      const cardBox = (await card.boundingBox())!;
      const buttonBox = (await finish.boundingBox())!;
      expect(cardBox.y - subBox.y - subBox.height).toBeCloseTo(24, 0);
      expect(buttonBox.y - cardBox.y - cardBox.height).toBeCloseTo(16, 0);
      await expect(page.getByTestId("one-agent-icon-connections").locator("svg")).toHaveCSS("color", "rgb(255, 255, 255)");
      await expect(page.getByTestId("one-agent-icon-connections").locator("svg")).toHaveCSS("opacity", "1");
      for (const property of ["height","border-radius","font-size","font-weight","background-color","color","opacity"]) {
        const expected = await page.getByTestId("primary-reference").evaluate((el, prop) => getComputedStyle(el).getPropertyValue(prop),property);
        await expect(finish).toHaveCSS(property,expected);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
      await page.screenshot({path:testInfo.outputPath("setup-required.png")});
      await page.evaluate(() => window.dispatchEvent(new Event("fixture:ai-choice-saved")));
      await expect(finish).toBeEnabled();
      await expect(page.getByRole("button", {name:"Choose your AI: Selected"})).toBeVisible();
      await page.screenshot({path:testInfo.outputPath("setup-saved.png")});
    });
  }
}
