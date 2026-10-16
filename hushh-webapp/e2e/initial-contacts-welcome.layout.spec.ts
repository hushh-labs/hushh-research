import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { awaitProductFont, productFontStyle, stripAppFontFaces } from "./fixtures/product-font";

let css: string;
let script: string;
let outDir: string;
test.beforeAll(async () => {
  test.setTimeout(120_000);
  const root = process.cwd();
  const { build } = await import("vite");
  const { Scanner } = await import("@tailwindcss/oxide");
  const scanner = new Scanner({});
  const candidates = new Set<string>();
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), "initial-welcome-"));
  await build({
    configFile: false,
    publicDir: false,
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
      ...["@/lib/firebase/auth-context", "@/lib/vault/vault-context", "@/components/vault/vault-lock-guard", "@/components/app-ui/native-test-beacon", "@/lib/capacitor/native-navigation", "@/lib/navigation/back-layers", "@/lib/auth/session-owner", "@/lib/agent/one-conversation-session", "@/lib/services/initial-contacts-onboarding-service", "./initial-contacts-bridge", "@/components/connect/circles/connect-circle-actions", "@/lib/one-location/service", "@/lib/services/referral-service", "@/lib/connect/invite-to-one", "@/lib/share/share-link", "@/lib/contacts/use-contact-invitations", "@/components/connections/contact-invitation-sheet", "@/components/one-location/redesign/circles/circle-grow-actions", "next/navigation"].map(find => ({ find, replacement: path.join(root, "e2e/fixtures/initial-contacts-welcome-boundaries.tsx") })),
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
        entry: path.join(root, "e2e/fixtures/initial-contacts-welcome.tsx"),
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

test.afterAll(() => { if (outDir) fs.rmSync(outDir, { recursive: true, force: true }); });

for (const width of [320, 393, 1440]) {
  test(`Circles v11 welcome and actions at ${width}px`, async ({ page }, testInfo) => {
    const height = width === 1440 ? 900 : 852;
    await page.setViewportSize({ width, height });
    await page.route('https://fixture.one.test/circles/answering-poster.png', (route) => route.fulfill({
      body: fs.readFileSync(path.join(process.cwd(), 'public/circles/answering-poster.png')),
      contentType: 'image/png',
    }));
    await page.setContent(`<html><head><base href="https://fixture.one.test/"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body><div id="root"></div></body></html>`);
    await page.addScriptTag({ content: script });
    await awaitProductFont(page);
    await expect(page.getByRole('heading', { name: 'Welcome to One, Aarav.' })).toBeVisible();
    await expect(page.getByLabel('Verified advisor')).toHaveCount(1);
    const font = await page.locator('.oc-root').evaluate((el) => getComputedStyle(el).fontFamily);
    expect(font).toContain('Plus Jakarta Sans');
    const poster = page.locator('.oc-art-mascot');
    await expect.poll(() => poster.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    const proceed = page.getByRole('button', { name: 'Continue to One', exact: true });
    await expect(proceed).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: testInfo.outputPath('welcome.png') });

    await page.getByRole('button', { name: 'Contacts, Manage' }).click();
    const contacts = page.getByRole('dialog', { name: 'Contacts' });
    await expect(contacts).toBeVisible();
    await expect(contacts.getByText('Very long friendly contact name 49', { exact: true })).toBeAttached();
    const scroller = page.locator('.oc-sheet');
    expect(await scroller.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
    await scroller.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await expect(contacts.getByText('Very long friendly contact name 49', { exact: true })).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath('contacts.png') });
    await contacts.getByRole('button', { name: 'Remove', exact: true }).last().click();
    const confirmation = page.getByRole('alertdialog');
    await expect(confirmation).toBeVisible();
    await expect(page.locator('body')).not.toHaveAttribute('data-removed');
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('fixture:back', { detail: 4 })));
    await expect(confirmation).toBeHidden();
    await contacts.getByRole('button', { name: 'Remove', exact: true }).last().click();
    await confirmation.getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(page.locator('body')).toHaveAttribute('data-removed', 'friend-49');
    await expect(contacts.getByText('Very long friendly contact name 49', { exact: true })).toHaveCount(0);
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('fixture:back', { detail: 2 })));
    await expect(contacts).toBeHidden();

    await page.getByRole('button', { name: 'Trusted, Choose' }).click();
    const trusted = page.getByRole('dialog', { name: 'Your trusted people' });
    await expect(trusted).toBeVisible();
    await trusted.getByRole('button', { name: 'Choose trusted people' }).click();
    await expect(page.getByRole('button', { name: 'Close people picker' })).toBeVisible();
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('fixture:back', { detail: 3 })));
    await expect(page.getByRole('button', { name: 'Close people picker' })).toHaveCount(0);
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('fixture:back', { detail: 2 })));
    await expect(trusted).toBeHidden();

    await page.getByRole('button', { name: 'Invite someone, Invite' }).click();
    const invite = page.getByRole('dialog', { name: 'Invite someone' });
    await expect(invite.getByText('ABCD2345', { exact: true })).toBeVisible();
    await expect(invite.getByRole('button', { name: 'Share circle link' })).toBeDisabled();
    await expect(invite.locator('.oc-invite-card').first().getByRole('button', { name: 'Invite' })).toBeEnabled();
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('fixture:back', { detail: 2 })));
    await proceed.click();
    await expect(page.locator('body')).toHaveAttribute('data-ack', 'yes');
    await expect(page.locator('body')).toHaveAttribute('data-queued', 'yes');
    await expect(page.locator('body')).toHaveAttribute('data-destination', '/finance');
  });
}

test('empty welcome matches the supplied phone states and keeps the action reachable', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('https://fixture.one.test/circles/answering-poster.png', (route) => route.fulfill({
    body: fs.readFileSync(path.join(process.cwd(), 'public/circles/answering-poster.png')),
    contentType: 'image/png',
  }));
  await page.setContent(`<html><head><base href="https://fixture.one.test/"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body><div id="root"></div></body></html>`);
  await page.evaluate(() => { (window as Window & { __circleEmpty?: boolean }).__circleEmpty = true; });
  await page.addScriptTag({ content: script });
  await awaitProductFont(page);
  await expect(page.getByRole('heading', { name: 'Welcome to One, hushh.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue to One' })).toBeInViewport();
  await expect(page.getByRole('button', { name: 'Find people with Google Contacts' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('empty-mobile-light.png') });
  await page.getByRole('button', { name: 'Contacts, Manage' }).click();
  await expect(page.getByRole('dialog', { name: 'Contacts' }).getByText('No people here yet')).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('fixture:back', { detail: 2 })));
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await expect(page.locator('.oc-root')).toHaveCSS('background-color', 'rgb(14, 16, 21)');
  await page.mouse.move(0, 0);
  await expect(page.getByRole('button', { name: 'Contacts, Manage' })).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await page.screenshot({ path: testInfo.outputPath('empty-mobile-dark.png') });
});
