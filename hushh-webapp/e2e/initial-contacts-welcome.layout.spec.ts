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
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "initial-welcome-"));
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
      "process.env.NEXT_PUBLIC_INITIAL_CONTACTS_ONBOARDING_ENABLED": JSON.stringify("true"),
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

for (const width of [320, 393, 1440]) {
  test(`initial Contacts welcome ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 852 });
    await page.setContent(`<html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body><div id="root"></div></body></html>`);
    await page.addScriptTag({ content: script });
    await expect(page.getByText("Welcome to One, Aarav", { exact: true })).toBeVisible();
    await awaitProductFont(page);
    await expect(page.getByText("Anjali Meena", { exact: true })).toBeVisible();
    await expect(page.getByText("Already on One", { exact: true })).toHaveCount(3);
    const proceed = page.getByRole("button", { name: "Continue to One", exact: true });
    await expect(proceed).toBeVisible();
    await expect(proceed).toBeInViewport();
    const profileImage = page.locator('[data-photo-url^="data:image/svg+xml"] img');
    await expect(profileImage).toBeVisible();
    await expect.poll(() => profileImage.evaluate((element) => {
      const image = element as HTMLImageElement;
      return image.complete && image.naturalWidth > 0;
    })).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: testInfo.outputPath("welcome.png") });
    await page.getByRole("button", { name: /Contacts.*Manage/ }).click();
    await expect(page.getByText("Very long friendly contact name 49", { exact: true })).toBeAttached();
    const scroller = page.locator('[data-slot="sheet-content"] .overflow-y-auto');
    expect(await scroller.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
    await scroller.evaluate(el => el.scrollTop = el.scrollHeight);
    await expect(page.getByText("Very long friendly contact name 49", { exact: true })).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath("roster.png") });
    await page.getByRole("button", { name: "Remove", exact: true }).last().click();
    const confirmation = page.getByRole("alertdialog");
    await expect(confirmation).toBeVisible();
    await expect(page.locator("body")).not.toHaveAttribute("data-removed");
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("fixture:back", { detail: 4 })));
    await expect(confirmation).toBeHidden();
    await expect(page.locator("body")).not.toHaveAttribute("data-removed");
    await page.getByRole("button", { name: "Remove", exact: true }).last().click();
    await confirmation.getByRole("button", { name: "Remove", exact: true }).click();
    await expect(page.locator("body")).toHaveAttribute("data-removed", "friend-49");
    await expect(confirmation).toBeHidden();
    await expect(page.getByText("Very long friendly contact name 49", { exact: true })).toHaveCount(0);
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("fixture:back", { detail: 2 })));
    await page.getByRole("button", { name: /^Trusted / }).click();
    await expect(page.getByRole("button", { name: "Close people picker", exact: true })).toBeVisible();
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("fixture:back", { detail: 3 })));
    await expect(page.getByRole("button", { name: "Close people picker", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: /Invite someone/ }).click();
    await expect(page.getByText("ABCD2345", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Share circle link", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Invite to One", exact: true })).toBeEnabled();
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("fixture:back", { detail: 2 })));
    await proceed.click();
    await expect(page.locator("body")).toHaveAttribute("data-ack", "yes");
    await expect(page.locator("body")).toHaveAttribute("data-queued", "yes");
    await expect(page.locator("body")).toHaveAttribute("data-destination", "/finance");
  });
}
