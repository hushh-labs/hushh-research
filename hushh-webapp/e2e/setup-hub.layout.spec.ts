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
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "setup-hub-"));
  let moduleCss = "";
  try {
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
      ...["@/components/account/use-marketing-preference", "@/components/onboarding/initial-contacts-bridge", "@/lib/services/initial-contacts-onboarding-service", "@/lib/services/personal-knowledge-model-service", "@/lib/one/ai-selection-vault", "@/components/onboarding/setup/local-first-vault-sequence", "@/lib/services/onboarding-buffer-migration-service", "@/lib/feed/personal-agent-readiness", "@/lib/services/account-identity-service", "@/lib/services/api-service", "@/lib/onboarding/use-capability-setup-states", "@/components/dashboard/one-agent-presence", "@/components/profile/public-profile-discovery-card", "@/lib/services/kai-profile-service", "next/navigation", "next/image", "@/lib/firebase/auth-context", "@/lib/vault/vault-context", "@/components/vault/vault-unlock-dialog", "@/components/app-ui/native-test-beacon", "@/lib/services/pre-vault-user-state-service", "@/lib/services/cache-service", "@/lib/services/one-setup-exit-service", "@/lib/services/pre-vault-sensitive-draft-service", "@/lib/services/finance-setup-draft-service", "@/lib/services/post-unlock-sync-service", "@/lib/connections/gemini-runtime-configuration", "@/lib/agent/one-conversation-session", "@/lib/kai/actions/voice-surface-metadata", "@/lib/agent/local-onboarding-actions"].map(find => ({ find, replacement: path.join(root, "e2e/fixtures/setup-hub-boundaries.tsx") })),
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
  moduleCss = fs.readdirSync(outDir).filter((name) => name.endsWith(".css")).map((name) => fs.readFileSync(path.join(outDir, name), "utf8")).join("\n");
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
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
  css = stripAppFontFaces(compiler.build([...candidates])) + productFontStyle() + moduleCss;
});

test.afterAll(() => {
  if (outDir) fs.rmSync(outDir, { recursive: true, force: true });
});

for (const { width, height } of [
  { width: 320, height: 568 },
  { width: 390, height: 844 },
  { width: 800, height: 600 },
  { width: 1440, height: 900 },
]) {
  for (const theme of ["light", "dark"]) {
    test(`Setup hub ${width}px ${theme}`, async ({page}, testInfo) => {
      page.on("pageerror", error => console.error("setup fixture:", error.message));
      await page.setViewportSize({width,height});
      await page.setContent(`<html class="${theme === "dark" ? "dark" : ""}"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body><div id="root"></div></body></html>`);
      await page.addScriptTag({content:script});
      const subtitle = page.locator('[data-slot="page-header-description"]');
      await expect(subtitle).toHaveText("Finish your agent setup.");
      await awaitProductFont(page);
      const card = page.getByTestId("one-setup-foundation");
      const finish = page.getByRole("button", {name:"Finish setup",exact:true});
      await expect(finish).toBeDisabled();
      await expect(page.getByRole("progressbar")).toHaveCount(0);
      await expect(page.getByRole("button", {name:/Choose your AI/})).toHaveCount(0);
      await expect(page.getByText("Set up the rest later.",{exact:true})).toHaveCount(0);
      const subBox = (await subtitle.boundingBox())!;
      const cardBox = (await card.boundingBox())!;
      const buttonBox = (await finish.boundingBox())!;
      expect(buttonBox.width).toBeCloseTo(width >= 640 ? 320 : cardBox.width, 0);
      expect(buttonBox.x + buttonBox.width / 2).toBeCloseTo(cardBox.x + cardBox.width / 2, 0);
      expect(cardBox.y - subBox.y - subBox.height).toBeCloseTo(24, 0);
      expect(buttonBox.y + buttonBox.height).toBeCloseTo(height - 16, 0);
      expect(buttonBox.y).toBeGreaterThan(cardBox.y + cardBox.height);
      await page.evaluate(() => document.documentElement.style.setProperty("--app-safe-area-bottom-effective", "34px"));
      const insetBox = (await finish.boundingBox())!;
      expect(insetBox.y + insetBox.height).toBeCloseTo(height - 16 - 34, 0);
      await expect(page.getByTestId("one-agent-icon-cloud").locator("svg")).toHaveCSS("color", "rgb(255, 255, 255)");
      await expect(page.getByTestId("one-agent-icon-cloud").locator("svg")).toHaveCSS("opacity", "1");
      for (const property of ["height","border-radius","font-size","font-weight","background-color","color","opacity"]) {
        const expected = await page.getByTestId("primary-reference").evaluate((el, prop) => getComputedStyle(el).getPropertyValue(prop),property);
        await expect(finish).toHaveCSS(property,expected);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
      const preferences = page.getByRole("region", { name: "Optional One email updates" });
      await expect(preferences.getByRole("combobox")).toBeVisible();
      await preferences.scrollIntoViewIfNeeded();
      await preferences.hover();
      await page.mouse.wheel(0, height);
      await expect.poll(async () => {
        const preferenceBox = (await preferences.boundingBox())!;
        const fixedAction = (await finish.boundingBox())!;
        return preferenceBox.y + preferenceBox.height - fixedAction.y;
      }).toBeLessThanOrEqual(0);
      await page.screenshot({ path: testInfo.outputPath("setup-required.png") });
      await finish.scrollIntoViewIfNeeded();
      await expect(finish).toBeInViewport();

      await page.evaluate(() => window.dispatchEvent(new Event("fixture:ai-choice-saved")));
      await expect(finish).toBeEnabled();
      await expect(page.getByRole("button", {name:"Agent home: Connected"})).toBeVisible();
      await page.screenshot({path:testInfo.outputPath("setup-saved.png")});
    });
  }
}
