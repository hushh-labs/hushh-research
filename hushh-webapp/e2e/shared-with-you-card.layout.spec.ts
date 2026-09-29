import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { awaitProductFont, productFontStyle, stripAppFontFaces } from "./fixtures/product-font";

/**
 * The secure "Shared with you" card (CONTRACT-2 decisions 1 and 2) and the
 * ask card's selectable rows, in a real browser: every state fits the phone
 * and desktop columns in light and dark, sensitive values hide and copy per
 * value, no machine label or "grant" wording reaches the page, and the ask
 * rows are tri-state with Send carrying exactly the choice. Set
 * SHARED_CARD_SHOT_DIR to also capture one screenshot per state and theme.
 */
let script: string;
let css: string;

const STATES = ["chat", "decrypted", "loading", "locked", "ended", "error", "unopenable", "profile", "legal", "ask"];

test.beforeAll(async () => {
  const root = process.cwd();
  const { build } = await import("vite");
  const { Scanner } = await import("@tailwindcss/oxide");
  const scanner = new Scanner({});
  const candidates = new Set<string>();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "shared-with-you-card-"));
  await build({
    configFile: false,
    logLevel: "error",
    oxc: { jsx: { runtime: "automatic" } },
    plugins: [{
      name: "fixture-css-candidates",
      transform(source, id) {
        if (!id.includes("node_modules") && /\.[tj]sx?$/.test(id))
          for (const candidate of scanner.scanFiles([{ content: source, extension: "tsx" }])) candidates.add(candidate);
      },
    }],
    resolve: {
      alias: [
        ...["@/hooks/use-auth", "@/lib/vault/vault-context", "@/lib/services/api-service", "@/lib/services/auth-service",
          "@/lib/cache/cache-sync-service", "@/lib/firebase/config", "next/link"].map((find) => ({
          find, replacement: path.join(root, "e2e/fixtures/requester-consent-card-boundaries.tsx"),
        })),
        { find: "@", replacement: root },
      ],
    },
    define: { "process.env.NODE_ENV": JSON.stringify("production"), "process.env": "{}" },
    build: {
      outDir, emptyOutDir: false,
      lib: { entry: path.join(root, "e2e/fixtures/shared-with-you-card.tsx"), name: "Fixture", formats: ["iife"], fileName: () => "fixture.js" },
    },
  });
  script = fs.readFileSync(path.join(outDir, "fixture.js"), "utf8");
  const { compile } = await import("tailwindcss");
  const compiler = await compile(
    fs.readFileSync(path.join(root, "app/globals.css"), "utf8").replace(/^@source\s+[^;]+;\s*$/gm, ""),
    {
      base: path.join(root, "app"),
      loadStylesheet: async (id, base) => {
        const file = id === "tailwindcss" ? path.join(root, "node_modules/tailwindcss/index.css")
          : id === "tw-animate-css" ? path.join(root, "node_modules/tw-animate-css/dist/tw-animate.css")
            : path.resolve(base, id);
        return { path: file, base: path.dirname(file), content: fs.readFileSync(file, "utf8") };
      },
    },
  );
  css = stripAppFontFaces(compiler.build([...candidates])) + productFontStyle();
});

async function open(page: Page, theme: "light" | "dark") {
  await page.route("http://localhost/shared-with-you-card", (route) => route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><html class="${theme === "dark" ? "dark" : ""}"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div></body></html>`,
  }));
  await page.goto("http://localhost/shared-with-you-card");
  await page.addScriptTag({ content: script });
  await awaitProductFont(page);
}

for (const theme of ["light", "dark"] as const)
  for (const [width, height] of [[393, 852], [1440, 900]] as const)
    test(`shared-with-you card and ask rows fit and read cleanly at ${width}px, ${theme}`, async ({ page, context }) => {
      await context.grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => undefined);
      await page.setViewportSize({ width, height });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await open(page, theme);

      const decrypted = page.locator("[data-state='decrypted']");
      await expect(decrypted.getByTestId("shared-with-you-secure")).toHaveText("Decrypted on this device");
      await expect(decrypted.getByText("Shared Sep 28 · Access until Oct 5").first()).toBeVisible();
      await expect(decrypted.getByTestId("shared-with-you-sensitive")).toHaveText("Sensitive · not shared with One’s model");
      await expect(decrypted).toContainText("C-Corporation");
      await expect(decrypted).toContainText("Neapolitan pizza");
      // Human words only: never a machine label, a raw sub-heading, JSON or grant wording.
      const everything = (await page.locator("main").textContent()) ?? "";
      expect(everything).not.toMatch(/TAX_RECORD|Tax Record Domain|Legal Entity Domain|Active grant|\bgrant\b|\bJSON\b|\bscope\b/i);
      expect(await decrypted.textContent()).not.toMatch(/\bfederal\b/);
      await expect(page.locator("[data-state='locked']").getByRole("button", { name: "Unlock to view" })).toBeVisible();
      await expect(page.locator("[data-state='locked']")).not.toContainText("C-Corporation");
      await expect(page.locator("[data-state='ended'] [data-testid='access-ended-notice']"))
        .toHaveText("Manish stopped sharing Tax record. One no longer uses it.");
      await expect(page.locator("[data-state='error']").getByRole("button", { name: "Try again" })).toBeVisible();
      await expect(page.locator("[data-state='unopenable']")).toContainText("Can’t be opened on this device.");
      await expect(page.locator("[data-state='unopenable']")).not.toContainText("C-Corporation");

      // Every tap target is at least 44px on a phone.
      if (width === 393) {
        for (const name of ["Hide Tax record", "Copy Filing form"]) {
          const box = await decrypted.getByRole("button", { name }).boundingBox();
          expect(box && box.height >= 43.5 && box.width >= 43.5, `${name} target`).toBe(true);
        }
      }

      // The skeleton holds the final rows' height: no jump when values land.
      const loadingRow = await page.locator("[data-state='loading'] [data-testid='shared-with-you-loading-outline'] > div").first().boundingBox();
      const readyRow = await page.locator("[data-state='chat'] [data-testid='shared-with-you-row']").first().boundingBox();
      expect(Math.abs((loadingRow?.height ?? 0) - (readyRow?.height ?? 0))).toBeLessThanOrEqual(2);

      for (const state of STATES) {
        const section = page.locator(`[data-state='${state}']`);
        await section.scrollIntoViewIfNeeded();
        expect(await section.evaluate((node) => node.scrollWidth <= node.clientWidth + 1), `${state} overflows`).toBe(true);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);

      const shotDir = process.env.SHARED_CARD_SHOT_DIR;
      if (shotDir) {
        fs.mkdirSync(shotDir, { recursive: true });
        for (const state of STATES) {
          await page.locator(`[data-state='${state}']`).screenshot({
            path: path.join(shotDir, `shared-with-you-${state}-${width}-${theme}.png`), animations: "disabled",
          });
        }
      }

      // Sensitive values hide per item, and copy puts one value on the clipboard.
      await decrypted.getByRole("button", { name: "Hide Tax record" }).click();
      await expect(decrypted.locator("[data-testid='shared-with-you-values'][data-hidden='true']")).toHaveCount(1);
      await expect(decrypted).not.toContainText("C-Corporation");
      await expect(decrypted).toContainText("Neapolitan pizza");
      await decrypted.getByRole("button", { name: "Show Tax record" }).click();
      await expect(decrypted).toContainText("C-Corporation");

      // An identifier inside a standard item (run 4, S3): the EIN alone is
      // marked Sensitive, and Hide masks it while the trade name stays.
      const legal = page.locator("[data-state='legal']");
      await expect(legal.getByTestId("shared-with-you-sensitive-field")).toHaveCount(1);
      await expect(legal.locator("[data-sensitive-field='true']")).toContainText("Federal EIN");
      await legal.getByRole("button", { name: "Hide Legal entity" }).click();
      await expect(legal).not.toContainText("00-0000000");
      await expect(legal).toContainText("Acme Coffee");

      // The ask rows: preselected, the group opens, tri-state, live summary, exact Send.
      const ask = page.locator("[data-state='ask']");
      const group = ask.getByRole("checkbox", { name: /Legal entity/ });
      await expect(group).toHaveAttribute("aria-checked", "true");
      await expect(ask.getByTestId("ask-proposal-summary")).toHaveText("3 items · 7 days");
      await group.focus();
      await page.keyboard.press("Enter");
      await expect(group).toHaveAttribute("aria-expanded", "true");
      const ein = ask.getByRole("checkbox", { name: "Employer id" });
      await ein.focus();
      await page.keyboard.press("Space");
      await expect(ein).toHaveAttribute("aria-checked", "false");
      await expect(group).toHaveAttribute("aria-checked", "mixed");
      await expect(ask.getByTestId("ask-proposal-summary")).toHaveText("2 items · 7 days");
      const row = await ask.getByRole("checkbox", { name: "Entity", exact: true }).boundingBox();
      expect((row?.height ?? 0) >= 43.5).toBe(true);
      expect(await ask.evaluate((node) => node.scrollWidth <= node.clientWidth + 1), "ask expanded overflows").toBe(true);
      if (shotDir) {
        await ask.screenshot({ path: path.join(shotDir, `shared-with-you-ask-expanded-${width}-${theme}.png`), animations: "disabled" });
      }
      await ask.getByRole("button", { name: "Send" }).click();
      await expect(page.getByTestId("ask-sent")).toHaveText("scope-entity,scope-address");

      // Nothing decrypted or chosen is ever written to browser storage.
      expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);
      expect(errors).toEqual([]);
    });
