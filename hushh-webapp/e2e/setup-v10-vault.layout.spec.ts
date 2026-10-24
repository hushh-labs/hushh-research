import { expect, test } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), "setup-v10-vault-"));
  const boundaries = path.join(root, "e2e/fixtures/setup-v10-vault-boundaries.tsx");
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
      ...[
        "next/image",
        "@/lib/vault/vault-context",
        "@/lib/services/vault-service",
        "@/lib/services/vault-bootstrap-service",
        "@/lib/services/vault-method-service",
        "@/lib/services/vault-method-prompt-local-service",
        "@/lib/services/vault-quick-unlock-trust-local-service",
        "@/lib/vault/prf-auth",
        "@/lib/hooks/use-hostname",
        "@/lib/testing/native-test",
        "@/lib/observability/client",
        "@/lib/utils/native-download",
        "@/lib/utils/clipboard",
        "@/hooks/use-auth",
        "@/lib/services/auth-service",
        "@/lib/services/account-service",
        "@/lib/services/api-service",
        "@/lib/firebase/config",
        "@/lib/flows/delete-account",
      ].map(find => ({ find, replacement: boundaries })),
      { find: "@", replacement: root },
    ] },
    define: { "process.env.NODE_ENV": JSON.stringify("production"), "process.env": "{}" },
    build: {
      outDir,
      emptyOutDir: false,
      lib: {
        entry: path.join(root, "e2e/fixtures/setup-v10-vault.tsx"),
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

test("locked-vault recovery stays compact and the quick-unlock description fits two lines", async ({ page }, testInfo) => {
  for (const width of [320, 393, 402, 430]) {
    await page.setViewportSize({ width, height: 852 });
    await page.setContent(`<html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body><div id="root" data-flow="unlock" data-email="you@gmail.com"></div></body></html>`);
    await page.evaluate(() => {
      if (!crypto.randomUUID) Object.defineProperty(crypto, "randomUUID", { value: () => "visual-unlock-attempt" });
    });
    await page.addScriptTag({ content: script });
    await awaitProductFont(page);
    const password = page.getByLabel("Vault password");
    await expect(password).toBeVisible();
    await expect(page.getByText(/older domain/)).toHaveCount(0);
    await password.fill("visual-fixture-password");
    await page.getByRole("button", { name: "Unlock", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Enable quicker unlock?" })).toBeVisible();
    const description = page.locator("[data-vault-flow-header] > p");
    await expect(description).toHaveText("Your password and recovery key still work.");
    expect(await description.evaluate(element => element.getBoundingClientRect().height / parseFloat(getComputedStyle(element).lineHeight))).toBeLessThanOrEqual(2.05);
    await page.getByRole("button", { name: "Enable Passkey", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("Your password still works.");
    if (width === 393) await page.screenshot({ path: testInfo.outputPath("quick-unlock-393.png") });
  }
});

test("deletion verification shows the centered Google mark beside its label", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 393, height: 852 });
  await page.setContent(`<html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body><div id="root" data-flow="delete"></div></body></html>`);
  await page.addScriptTag({ content: script });
  await awaitProductFont(page);
  const provider = page.getByRole("button", { name: "Continue with Google" });
  await expect(provider).toBeVisible();
  const delta = await provider.evaluate(element => {
    const button = element.getBoundingClientRect();
    const content = element.querySelector("[data-auth-provider-content]")!.getBoundingClientRect();
    const icon = element.querySelector("[data-auth-provider-icon] svg")!.getBoundingClientRect();
    return { center: Math.abs(button.x + button.width / 2 - content.x - content.width / 2), iconWidth: icon.width };
  });
  expect(delta.center).toBeLessThanOrEqual(1);
  expect(delta.iconWidth).toBe(24);
  await page.screenshot({ path: testInfo.outputPath("delete-verification-393.png") });
});

const scenarios = [
  { width: 320, height: 568, theme: "light", email: "you@gmail.com", brand: "Google email domain" },
  { width: 390, height: 844, theme: "light", email: "you@icloud.com", brand: "Apple email domain" },
  { width: 390, height: 844, theme: "dark", email: "you@outlook.com", brand: "Microsoft email domain" },
  { width: 1440, height: 900, theme: "light", email: "you@gmail.com", brand: "Google email domain" },
] as const;

for (const scenario of scenarios) {
  test(`Setup V10 lock and recovery ${scenario.width}×${scenario.height} ${scenario.theme}`, async ({ page }, testInfo) => {
    const browserErrors: string[] = [];
    page.on("pageerror", error => browserErrors.push(error.message));
    page.on("console", message => {
      if (message.type() === "error") browserErrors.push(message.text());
    });
    await page.setViewportSize({ width: scenario.width, height: scenario.height });
    await page.route("http://setup.local/brand/**", route => route.fulfill({
      path: path.join(process.cwd(), "public", new URL(route.request().url()).pathname),
    }));
    await page.route("http://setup.local/onboarding/intro-v2/*", async route => {
      const name = path.basename(new URL(route.request().url()).pathname);
      await route.fulfill({
        body: fs.readFileSync(path.join(process.cwd(), "public/onboarding/intro-v2", name)),
        contentType: "image/png",
      });
    });
    await page.setContent(`<html class="${scenario.theme === "dark" ? "dark" : ""}"><head><base href="http://setup.local/"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><style>${css}</style></head><body><div id="root" data-email="${scenario.email}"></div></body></html>`);
    // about:blank is not a secure origin, so Web Crypto omits randomUUID.
    // The production flow uses it for attempt IDs before calling the stubbed vault.
    await page.evaluate(() => {
      if (!crypto.randomUUID) Object.defineProperty(crypto, "randomUUID", { value: () => {
        const hex = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("");
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
      } });
    });
    await page.addScriptTag({ content: script });
    await awaitProductFont(page);

    const surface = page.locator('[data-setup-v10-stage="lock"]');
    const form = page.locator("[data-vault-create-form]");
    const heading = form.locator('[data-vault-flow-header] [role="heading"]');
    const password = page.locator("#passphrase");
    const confirm = page.locator("#confirm");
    const create = page.locator("[data-vault-create-cta]");
    await expect(surface).toBeVisible();
    await expect(page.getByRole("button", { name: "Account actions" })).toBeVisible();
    await expect(heading).toHaveText("Set a lock");
    await expect(heading).toHaveCSS("font-family", /Plus Jakarta Sans/);
    await expect(password).toHaveCSS("font-size", "16px");
    const identity = page.getByRole("img", { name: scenario.brand, exact: true });
    await expect(identity).toBeVisible();
    await expect.poll(() => identity.locator("img").evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    for (const field of [password, confirm]) {
      const shell = field.locator("..");
      const toggle = shell.getByRole("button");
      await expect(toggle).toHaveAccessibleName("Show password");
      await toggle.hover();
      await expect(toggle).toHaveAttribute("title", "Show password");
      const eye = toggle.locator("svg");
      const irisStroke = await eye.locator("circle").evaluate(element => getComputedStyle(element).stroke);
      const slashStroke = await eye.locator("path").last().evaluate(element => getComputedStyle(element).stroke);
      expect(irisStroke).not.toBe(slashStroke);
      const accent = await eye.evaluate(element => {
        const probe = document.createElement("span");
        probe.style.color = getComputedStyle(element).getPropertyValue("--ios-account-accent").trim();
        return probe.style.color;
      });
      await expect(eye.locator("circle")).toHaveCSS("stroke", accent);
      await expect(eye.locator("path").last()).toHaveCSS("stroke", await eye.evaluate(element => getComputedStyle(element).color));
      await toggle.click();
      await expect(field).toHaveAttribute("type", "text");
      await expect(toggle).toHaveAttribute("title", "Hide password");
      await toggle.click();
      await expect(field).toHaveAttribute("type", "password");
      await expect(toggle).toHaveAttribute("title", "Show password");
      await heading.click();
      await page.mouse.move(0, 0);
      const inactiveFill = await shell.evaluate(element => getComputedStyle(element).backgroundColor);
      await field.focus();
      await expect(field).toHaveCSS("outline-style", "none");
      await expect(field).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      expect(await shell.evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe(inactiveFill);
      await expect(shell).not.toHaveCSS("box-shadow", "none");
    }
    await expect(page.getByText("Also unlock with a passkey")).toBeVisible();
    await expect(create).toBeDisabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: testInfo.outputPath("lock-top.png") });

    if (scenario.width === 320) {
      await page.evaluate(() => {
        document.documentElement.classList.add("native-keyboard-inset", "kb-open");
        document.documentElement.style.setProperty("--kb-height", "320px");
      });
      await password.focus();
      await expect.poll(() => surface.evaluate(element => Math.round(element.getBoundingClientRect().height))).toBe(248);
      await create.scrollIntoViewIfNeeded();
      const withinScrollRoot = await create.evaluate(button => {
        const parent = button.closest('[data-setup-v10-stage="lock"]');
        if (!parent) return false;
        const control = button.getBoundingClientRect();
        const scrollRoot = parent.getBoundingClientRect();
        return control.top >= scrollRoot.top - 1 && control.bottom <= scrollRoot.bottom + 1;
      });
      expect(withinScrollRoot).toBe(true);
      await page.screenshot({ path: testInfo.outputPath("lock-keyboard-cta.png") });
      await page.evaluate(() => {
        document.documentElement.classList.remove("native-keyboard-inset", "kb-open");
        document.documentElement.style.removeProperty("--kb-height");
      });

      // Safari and in-app browsers can resize the visual viewport instead of
      // publishing a native keyboard inset. The same scroll root must work.
      await page.setViewportSize({ width: 320, height: 248 });
      await create.scrollIntoViewIfNeeded();
      const webKeyboardVisible = await create.evaluate(button => {
        const parent = button.closest('[data-setup-v10-stage="lock"]');
        if (!parent) return false;
        const control = button.getBoundingClientRect();
        const scrollRoot = parent.getBoundingClientRect();
        return control.top >= scrollRoot.top - 1 && control.bottom <= scrollRoot.bottom + 1;
      });
      expect(webKeyboardVisible).toBe(true);
      await page.screenshot({ path: testInfo.outputPath("lock-visual-viewport-cta.png") });
      await page.setViewportSize({ width: 320, height: 568 });
    }

    await password.fill("fixture-password-123");
    await confirm.fill("fixture-password-123");
    await expect(create).toBeEnabled();
    await create.click();
    const recovery = page.locator('[data-setup-v10-stage="recovery"]');
    try {
      await expect(recovery).toBeVisible();
    } catch (error) {
      throw new Error(`Recovery step did not open. Browser errors: ${browserErrors.join(" | ") || "none"}. ${String(error)}`);
    }
    await expect(page.getByRole("button", { name: "Account actions" })).toHaveCount(0);
    await expect(page.locator("[data-vault-recovery-key]")).toBeVisible();
    await expect(page.locator("[data-vault-recovery-code]")).toContainText("DEMO-ONLY-NOT-A-RECOVERY-KEY");
    await expect(page.locator("[data-vault-recovery-cta]")).toBeVisible();
    await expect(page.locator("[data-vault-recovery-cta] svg")).toBeVisible();
    const recoveryMascot = recovery.locator('img[src="/onboarding/intro-v2/answering-poster.png"]');
    await expect(recoveryMascot).toBeVisible();
    await expect.poll(() => recoveryMascot.evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    await recovery.evaluate(element => { element.scrollTop = 0; });
    await page.screenshot({ path: testInfo.outputPath("recovery-top.png") });
    await page.locator("[data-vault-recovery-cta]").scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath("recovery-cta.png") });
  });
}
