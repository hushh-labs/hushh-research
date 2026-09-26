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
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "phone-entry-"));
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
      ...["next/navigation", "next/image", "@/lib/firebase/auth-context", "@/components/app-ui/native-route-marker", "@/components/vault/vault-lock-guard", "@/lib/services/account-identity-service", "@/lib/services/onboarding-route-cookie", "@/lib/services/post-auth-route-service", "@/lib/services/pre-vault-user-state-service", "@/lib/services/ria-service", "@/lib/voice/voice-surface-metadata", "@/lib/agent/local-onboarding-actions", "@/lib/services/api-service", "@/lib/observability/client"].map(find => ({ find, replacement: path.join(root, "e2e/fixtures/phone-entry-boundaries.tsx") })),
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

for (const viewport of [{width:320,height:568}, {width:393,height:852}, {width:430,height:932}, {width:852,height:393}, {width:1440,height:900}]) {
  for (const theme of ["light", "dark"]) {
    test(`Phone entry ${viewport.width}x${viewport.height} ${theme}`, async ({page}, testInfo) => {
      await page.setViewportSize(viewport);
      await page.route("https://phone-entry.test/onboarding/**", async route => {
        const asset = new URL(route.request().url()).pathname;
        await route.fulfill({ path: path.join(process.cwd(), "public", asset) });
      });
      await page.setContent(`<html class="${theme === "dark" ? "dark" : ""}" style="--app-safe-area-top-effective:24px;--app-safe-area-bottom-effective:34px"><head><base href="https://phone-entry.test/"><style>${css}</style></head><body><div id="root"></div></body></html>`);
      await page.addScriptTag({content:script});
      const heading = page.getByRole("heading", {name:"Enter your phone number", exact:true});
      await expect(heading).toBeVisible();
      await awaitProductFont(page);
      const back = (await page.getByRole("button", {name:"Go back", exact:true}).boundingBox())!;
      const account = (await page.getByRole("button", {name:"Account actions", exact:true}).boundingBox())!;
      expect(back.x).toBe(16);
      expect(viewport.width - account.x - account.width).toBe(16);
      expect(back.y).toBe(36); // 24px simulated safe area + 12px top spacing.
      expect(account.y).toBe(back.y);
      expect(back.width).toBe(44);
      expect(back.height).toBe(44);
      expect(account.width).toBe(44);
      expect(account.height).toBe(44);
      await expect(heading).toHaveCSS("font-size", "30px");
      await expect(heading).toHaveCSS("font-weight", "600");
      await expect(heading).toHaveCSS("line-height", "36px");
      const input = page.getByRole("textbox", {name:"Phone number", exact:true});
      await expect(input).toHaveAttribute("placeholder", "Phone number");
      await expect(input).toHaveValue("");
      const country = page.getByRole("button", {name:/^Country code:/});
      await expect(country).toContainText("US");
      const helper = page.locator("[data-figma-phone-helper]");
      await expect(helper).toHaveCSS("font-size", "14px");
      await expect(helper).toHaveCSS("line-height", "20px");
      await expect(helper).toHaveText("By using your mobile number, you may receive SMS notifications from us. Learn more");
      const button = page.getByRole("button", {name:"Continue", exact:true});
      await expect(button).toHaveCSS("font-size", "17px");
      await expect(button).toHaveCSS("font-weight", "600");
      await expect(button.locator("span").first()).toHaveCSS("font-weight", "600");
      await expect(button.locator("span").first()).toHaveCSS("color", "rgb(255, 255, 255)");
      const reference = page.getByTestId("shared-primary-reference");
      for (const property of ["height", "border-radius", "font-family", "font-size", "font-weight", "line-height", "letter-spacing", "color", "background-color"]) {
        const expected = await reference.evaluate((el, prop) => getComputedStyle(el).getPropertyValue(prop), property);
        await expect(button).toHaveCSS(property, expected);
      }
      const box = (await button.boundingBox())!;
      const text = (await helper.boundingBox())!;
      const form = (await page.locator("[data-figma-phone-fields]").boundingBox())!;
      expect(box.height).toBe(50);
      expect(box.y - text.y - text.height).toBeCloseTo(16, 0);
      expect(text.x).toBeCloseTo(form.x, 0);
      expect(box.x).toBeCloseTo(form.x, 0);
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
      await button.scrollIntoViewIfNeeded();
      await expect(button).toBeInViewport();
      await expect(page.getByRole("alert")).toHaveCount(0);
      await button.click();
      const error = page.getByRole("alert");
      await expect(error).toHaveText("Enter your phone number.");
      await expect(input).toHaveAttribute("aria-invalid", "true");
      const field = page.locator('[data-figma-phone-field="number"] [data-slot="input-group"]');
      const errorBox = (await error.boundingBox())!;
      const fieldBox = (await field.boundingBox())!;
      expect(errorBox.y - fieldBox.y - fieldBox.height).toBeCloseTo(8, 0);
      const errorColor = await error.evaluate(el => getComputedStyle(el).color);
      await expect(field).toHaveCSS("border-top-color", errorColor);
      await expect(field).toHaveCSS("border-top-style", "solid");
      await expect(field).toHaveCSS("border-top-width", "1px");
      await input.fill("123");
      await button.click();
      await expect(error).toHaveText("Enter a valid phone number.");
      await page.screenshot({path:testInfo.outputPath("phone-entry-error.png")});
      await input.fill("6505550101");
      await expect(error).toHaveCount(0);
      await expect(input).toHaveAttribute("aria-invalid", "false");
      await page.screenshot({path:testInfo.outputPath("phone-entry.png")});
      await page.getByRole("button", {name:"Learn more", exact:true}).click();
      await expect(page.getByRole("dialog")).toContainText("We’ll send a verification code to confirm your mobile number. You may also receive SMS notifications from Hushh.");
    });
  }
}
