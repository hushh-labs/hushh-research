import { expect, test } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  awaitProductFont,
  productFontStyle,
  stripAppFontFaces,
} from "./fixtures/product-font";


let script: string;
let css: string;
let fixtureDir: string;

test.beforeAll(async () => {
  const root = process.cwd();
  const { build } = await import("vite");
  const { Scanner } = await import("@tailwindcss/oxide");
  const scanner = new Scanner({});
  const candidates = new Set<string>();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "mail-workspace-"));
  fixtureDir = outDir;
  const boundaries = path.join(root, "e2e/fixtures/mail-workspace-boundaries.tsx");
  const stubbed = ['next/navigation', '@/lib/consent/use-consent-pending-summary-count', '@/lib/feed/use-feed-unread-count', '@/lib/firebase/config', '@/lib/firebase/auth-context', '@/hooks/use-auth', '@/lib/vault/vault-context', '@/hooks/use-effective-avatar-url', '@/lib/persona/persona-context', '@/lib/capacitor/native-presentation-regions', '@/lib/services/vault-service', '@/lib/flows/delete-account', '@/lib/profile/gmail-connector-store', '@/lib/kai/actions/voice-surface-metadata', '@/lib/agent/local-onboarding-actions', '@/lib/capacitor', '@/lib/services/pre-vault-user-state-service', '@/lib/services/kyc-identity-profile-pkm-service', '@/lib/services/gmail-information-requests-service', '@/components/vault/vault-unlock-dialog', '@/lib/services/api-service'];
  stubbed.push('@/lib/services/private-agent-specialist-chat');
  await build({
    configFile: false,
    logLevel: "error",
    oxc: { jsx: { runtime: "automatic" } },
    plugins: [
      { name: "relative-api-boundary", enforce: "pre", resolveId(source, importer) {
        if (importer && source.startsWith('.') && path.resolve(path.dirname(importer), source).replace(/\.(tsx?|jsx?)$/, '') === path.join(root, 'lib/services/api-service')) return boundaries;
      } },
      { name: "relative-boundaries", resolveId(source, importer) {
        if (!importer || !source.startsWith(".")) return;
        const candidate = path.resolve(path.dirname(importer), source).replace(/\.(tsx?|jsx?)$/, "");
        if (stubbed.some(value => value.startsWith("@/") && path.join(root, value.slice(2)) === candidate)) return boundaries;
      } },
      {
        // Candidates are derived from every transformed module, so a class the
        // card renders cannot be missing from the CSS. A hand-maintained list
        // would let an unregistered class emit no style and still pass.
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
        ...stubbed.map(find => ({ find: new RegExp(`^${find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`), replacement: boundaries })),
        { find: "@", replacement: root },
      ],
    },
    define: {
      "process.env.NODE_ENV": JSON.stringify("production"),
      "process.env": "{}",
    },
    build: {
      copyPublicDir: false,
      outDir,
      emptyOutDir: false,
      lib: {
        entry: path.join(root, "e2e/fixtures/mail-workspace.tsx"),
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
              ? path.join(root, "node_modules/tw-animate-css/dist/tw-animate.css")
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
  css += fs.readdirSync(outDir).filter(file => file.endsWith(".css"))
    .map(file => fs.readFileSync(path.join(outDir, file), "utf8")).join("\n");
});


test.afterAll(() => { if (fixtureDir) fs.rmSync(fixtureDir, { recursive: true, force: true }); });

for (const width of [393, 1280]) {
  test(`Saved mailbox receipt reports preserve currency, scope and mobile layout at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("http://localhost/fixture.js", route => route.fulfill({ contentType: "application/javascript", body: script }));
    await page.route("http://localhost/mail-reports", route => route.fulfill({ contentType: "text/html",
      body: `<!doctype html><html data-workspace="overview" data-saved-report="1"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>` }));
    await page.goto("http://localhost/mail-reports");
    const report = page.getByRole("region", { name: "Saved receipt report" });
    await expect(report).toBeVisible();
    await awaitProductFont(page);
    await report.getByLabel("Report month").fill("2026-10");
    await report.getByRole("button", { name: "Show report" }).click();
    await expect(report.getByRole("status")).toContainText("2 saved mailboxes");
    await expect(report.getByRole("status")).toContainText("USD 0.30");
    await expect(report.getByRole("status")).toContainText("INR 30.00");
    await expect(report.getByRole("status")).toContainText("1 duplicate copies removed");
    await report.getByLabel("Report type").click();
    await page.getByRole("option", { name: "Recurring charges paid" }).click();
    await expect(report.getByRole("status")).toHaveCount(0);
    await report.getByRole("button", { name: "Show report" }).click();
    await expect(report.getByRole("status")).toContainText("USD 0.30");
    await expect(report.getByRole("status")).not.toContainText("INR 30.00");
    await report.getByLabel("Report mailboxes").click();
    await page.getByRole("option", { name: "alex.morgan@northstar.example" }).click();
    await report.getByRole("button", { name: "Show report" }).click();
    await expect(report.getByRole("status")).toContainText("USD 0.10");
    const details = report.locator("summary");
    await details.scrollIntoViewIfNeeded();
    await details.click();
    await expect(report.getByText(/Includes annual charges/)).toBeVisible();
    const frame = await page.getByTestId("app-bottom-nav-frame").boundingBox();
    const bounds = await details.boundingBox();
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(frame!.y);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    expect(errors).toEqual([]);
    await report.screenshot({ path: testInfo.outputPath(`saved-mail-report-${width}.png`) });
  });
}

for (const width of [393, 1280]) {
  test(`Google mailbox accounts fit and disconnect independently at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('http://localhost/fixture.js', route => route.fulfill({ contentType: 'application/javascript', body: script }));
    await page.route('http://localhost/mail-workspace', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><html data-workspace="overview" data-mail-accounts="1"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>` }));
    await page.goto('http://localhost/mail-workspace');
    const accounts = page.getByRole('region', { name: 'Connected mailboxes' });
    await expect(accounts.getByText('personal@gmail.example')).toBeVisible();
    await awaitProductFont(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    for (const button of await accounts.getByRole('button').all()) {
      expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    await accounts.screenshot({ path: testInfo.outputPath(`google-mailboxes-${width}.png`) });
    await accounts.getByRole('button', { name: 'Disconnect' }).nth(1).click();
    await expect(accounts.getByText('personal@gmail.example')).toHaveCount(0);
    await expect(accounts.getByText('work@workspace.example')).toBeVisible();
    await page.evaluate(() => window.addEventListener('hushh:google-connector-intent', event => { document.documentElement.dataset.mailIntent = (event as CustomEvent<string>).detail; }, { once: true }));
    await accounts.getByRole('button', { name: 'Add Google account' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-mail-intent', 'hushh://one/connect/google/gmail/add');
    expect(errors).toEqual([]);
  });
}

for (const width of [360, 393, 430, 768, 1024, 1440]) {
  for (const theme of ["light", "dark"] as const) {
    for (const workspace of ["overview", "kyc", "receipts"] as const) {
      test(`Mail ${workspace} ${theme} at ${width}px uses the Connect frame`, async ({ page }, testInfo) => {
        await page.setViewportSize({ width, height: width >= 768 ? 1000 : 852 });
        await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
        const errors: string[] = [];
        page.on("pageerror", error => errors.push(error.message));
        await page.route("http://localhost/fixture.js", route => route.fulfill({ contentType: "application/javascript; charset=utf-8", body: script }));
        await page.route("http://localhost/mail-workspace", route => route.fulfill({
          contentType: "text/html; charset=utf-8",
          body: `<!doctype html><html class="${theme}" data-workspace="${workspace}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`,
        }));
        await page.goto("http://localhost/mail-workspace");
        await expect(page.getByRole("tablist", { name: "Gmail workspace" })).toBeVisible();
        await awaitProductFont(page);
        const frame = page.locator(".app-page-shell");
        const geometry = await frame.evaluate(element => ({ width: element.getBoundingClientRect().width, gutter: parseFloat(getComputedStyle(element).paddingLeft) }));
        expect(geometry.width).toBe(Math.min(width, 728));
        expect(geometry.gutter).toBe(width <= 620 ? 20 : 24);
        const header = page.getByTestId("top-app-bar-breadcrumb-trail");
        await expect(header).toHaveText("Mail");
        const title = await header.locator("span").last().evaluate(element => { const style = getComputedStyle(element); return [style.fontSize, style.lineHeight, style.fontWeight]; });
        expect(title).toEqual(["17px", "22px", "600"]);
        const tabs = page.getByRole("tablist", { name: "Gmail workspace" });
        expect((await tabs.boundingBox())!.height).toBe(36);
        const tabType = await tabs.locator("[data-ui-contract=required-title]").first().evaluate(element => { const style = getComputedStyle(element); return [style.fontSize, style.lineHeight, style.fontWeight]; });
        expect(tabType).toEqual(["15px", "20px", "550"]);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
        if (workspace === "overview") {
          const chat = page.getByRole("button", { name: "Chat with One", exact: true });
          await expect(chat).toBeVisible();
          const appearance = await chat.evaluate(element => { const style = getComputedStyle(element); return [style.fontSize, style.lineHeight, style.fontWeight, element.getBoundingClientRect().height]; });
          expect(appearance).toEqual(["12px", "18px", "550", 44]);
          const hero = page.getByRole("heading", { name: "Draft with One." });
          const position = await hero.boundingBox();
          const manage = page.getByRole("button", { name: "Manage", exact: true });
          await manage.click();
          const menu = page.getByRole("menu");
          await expect(menu).toBeVisible();
          expect(await hero.boundingBox()).toEqual(position);
          const box = (await menu.boundingBox())!;
          expect(box.x).toBeGreaterThanOrEqual(0);
          expect(box.x + box.width).toBeLessThanOrEqual(width);
          await page.keyboard.press("Escape");
          await expect(manage).toBeFocused();
        }
        if (workspace === "kyc") await expect(page.getByRole("button", { name: "Paste details", exact: true })).toBeVisible();
        if (workspace === "receipts") await expect(page.getByText("Amazon", { exact: true })).toBeVisible();
        expect(errors).toEqual([]);
        await page.screenshot({ path: testInfo.outputPath(`mail-${workspace}-${width}-${theme}.png`) });
      });
    }
  }
}
