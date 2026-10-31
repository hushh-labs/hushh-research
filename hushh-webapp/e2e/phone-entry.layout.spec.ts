import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { awaitProductFont, productFontStyle, stripAppFontFaces } from "./fixtures/product-font";

let css: string;
let script: string;
let outDir = "";
test.beforeAll(async () => {
  const root = process.cwd();
  const { build } = await import("vite");
  const { Scanner } = await import("@tailwindcss/oxide");
  const scanner = new Scanner({});
  const candidates = new Set<string>();
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), "phone-entry-"));
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
      ...["next/navigation", "next/image", "@/lib/firebase/auth-context", "@/components/app-ui/native-route-marker", "@/components/vault/vault-lock-guard", "@/lib/services/account-identity-service", "@/lib/services/onboarding-route-cookie", "@/lib/services/post-auth-route-service", "@/lib/services/pre-vault-user-state-service", "@/lib/services/ria-service", "@/lib/kai/actions/voice-surface-metadata", "@/lib/agent/local-onboarding-actions", "@/lib/services/api-service", "@/lib/observability/client"].map(find => ({ find, replacement: path.join(root, "e2e/fixtures/phone-entry-boundaries.tsx") })),
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
        entry: path.join(root, "e2e/fixtures/phone-entry.tsx"),
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
  {width:320,height:568}, {width:393,height:852}, {width:430,height:932},
  {width:852,height:393}, {width:1440,height:900}
]) {
  for (const theme of ["light", "dark"]) {
    test("Phone and OTP " + viewport.width + "x" + viewport.height + " " + theme, async ({page}, testInfo) => {
      await page.setViewportSize(viewport);
      await page.route("https://phone-entry.test/", route => route.fulfill({body:"<!doctype html><html></html>", contentType:"text/html"}));
      await page.route("https://phone-entry.test/onboarding/**", async route => {
        const asset = new URL(route.request().url()).pathname;
        await route.fulfill({ path: path.join(process.cwd(), "public", asset) });
      });
      await page.goto("https://phone-entry.test/");
      await page.setContent('<html class="' + (theme === "dark" ? "dark" : "") + '" style="--app-safe-area-top-effective:24px;--app-safe-area-bottom-effective:34px"><head><base href="https://phone-entry.test/"><style>' + css + '</style></head><body><div id="root"></div></body></html>');
      await page.addScriptTag({content:script});
      await awaitProductFont(page);

      const phoneHeading = page.getByRole("heading", {name:"Enter your phone number", exact:true});
      await expect(phoneHeading).toBeVisible();
      await expect(phoneHeading).toHaveCSS("font-family", /Plus Jakarta Sans/);
      await expect(phoneHeading).toHaveCSS("font-weight", "600");
      await expect(phoneHeading).toHaveCSS("font-size", viewport.width >= 800 ? "42px" : viewport.width <= 355 ? "28px" : "30px");
      const phoneScene = page.locator('[data-phone-scene="phone"]');
      await expect(phoneScene.locator("img")).toHaveJSProperty("naturalWidth", 512);
      const phoneInput = page.getByRole("textbox", {name:"Phone number", exact:true});
      await expect(phoneInput).toHaveAttribute("type", "tel");
      const country = page.getByRole("button", {name:/^Country code:/});
      await expect(country).toBeVisible();
      const helper = page.locator("[data-figma-phone-helper]");
      const helperBefore = (await helper.boundingBox())!;
      await country.click();
      const countryPanel = page.locator("#phone-flow-country-options");
      await expect(countryPanel).toBeVisible();
      const helperAfter = (await helper.boundingBox())!;
      expect(helperAfter.y).toBeGreaterThan(helperBefore.y + 40);
      const countrySearch = countryPanel.getByRole("searchbox", {name:"Search countries"});
      const searchShell = countrySearch.locator("..");
      const inactiveSearchFill = await searchShell.evaluate(element => getComputedStyle(element).backgroundColor);
      await countrySearch.fill("United States");
      await expect(countrySearch).toHaveCSS("outline-style", "none");
      await expect(countrySearch).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      expect(await searchShell.evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe(inactiveSearchFill);
      await expect(searchShell).not.toHaveCSS("box-shadow", "none");
      await page.screenshot({path:testInfo.outputPath("country-search-focused.png")});
      await countryPanel.getByRole("option", {name:"United States (+1)"}).click();
      await expect(countryPanel).toHaveCount(0);
      await expect(helper).toContainText("We may send SMS notifications.");
      const continueButton = page.getByRole("button", {name:"Continue", exact:true});
      await expect(continueButton).toHaveCSS("height", "52px");
      await expect(continueButton).toHaveCSS("background-color", "rgb(0, 113, 227)");
      const shell = page.getByTestId("phone-mandate-screen");
      const back = (await page.getByRole("button", {name:"Go back", exact:true}).boundingBox())!;
      const account = (await page.getByRole("button", {name:"Account actions", exact:true}).boundingBox())!;
      expect(back.width).toBe(44);
      expect(account.width).toBe(44);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
      const sceneBox = (await phoneScene.boundingBox())!;
      const headingBox = (await phoneHeading.boundingBox())!;
      if (viewport.width >= 800) expect(sceneBox.x + sceneBox.width).toBeLessThan(headingBox.x);
      else expect(sceneBox.y + sceneBox.height).toBeLessThan(headingBox.y);
      await page.screenshot({path:testInfo.outputPath("phone.png")});

      await continueButton.click();
      await expect(page.getByRole("alert")).toHaveText("Enter your phone number.");
      await phoneInput.fill("6505550101");
      await expect(page.getByRole("alert")).toHaveCount(0);
      await continueButton.click();
      const codeHeading = page.getByRole("heading", {name:"Enter your code", exact:true});
      await expect(codeHeading).toBeVisible();
      const codeScene = page.locator('[data-phone-scene="code"]');
      await expect(codeScene.locator("img")).toHaveJSProperty("naturalWidth", 512);
      const codeInput = page.getByRole("textbox", {name:"One-time code", exact:true});
      await expect(codeInput).toHaveAttribute("autocomplete", "one-time-code");
      await expect(codeInput).toHaveAttribute("inputmode", "numeric");
      await expect(page.locator("[data-otp-cells] > div")).toHaveCount(6);
      const confirm = page.getByRole("button", {name:"Confirm", exact:true});
      await expect(confirm).toBeDisabled();
      await expect(confirm).toHaveCSS("opacity", "1");
      await expect(confirm).toHaveCSS("background-color", theme === "dark" ? "rgb(23, 70, 124)" : "rgb(210, 229, 249)");
      await page.screenshot({path:testInfo.outputPath("code-empty.png")});
      await codeInput.fill("123456");
      await expect(codeInput).toHaveValue("123456");
      await expect(confirm).toBeEnabled();
      await expect(confirm).toHaveCSS("background-color", "rgb(0, 113, 227)");
      await page.screenshot({path:testInfo.outputPath("code.png")});

      if (viewport.width < 800) {
        await page.evaluate(() => {
          const root = document.documentElement;
          root.classList.add("native-keyboard-inset", "kb-open");
          root.style.setProperty("--kb-height", "300px");
        });
        await expect(codeScene).toBeHidden();
        const visibleHeight = await shell.evaluate(el => el.getBoundingClientRect().height);
        expect(visibleHeight).toBeLessThanOrEqual(viewport.height - 299);
        await confirm.scrollIntoViewIfNeeded();
        await expect(confirm).toBeInViewport({ratio:0.9});
        await page.screenshot({path:testInfo.outputPath("code-keyboard.png")});
        await page.evaluate(() => {
          document.documentElement.classList.remove("native-keyboard-inset", "kb-open");
          document.documentElement.style.removeProperty("--kb-height");
        });
      }
      await page.getByRole("button", {name:"Go back", exact:true}).click();
      await expect(phoneHeading).toBeVisible();
      await phoneInput.fill("6505550101");
      await continueButton.click();
      await expect(codeHeading).toBeVisible();
      await page.getByRole("button", {name:"Use a Different number", exact:true}).click();
      await expect(phoneHeading).toBeVisible();
    });
  }
}
