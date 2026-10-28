import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  awaitProductFont,
  productFontStyle,
  stripAppFontFaces,
} from "./fixtures/product-font";

let css: string;
let script: string;
let outDir = "";
test.beforeAll(async () => {
  const root = process.cwd();
  const { build } = await import("vite");
  const { Scanner } = await import("@tailwindcss/oxide");
  const scanner = new Scanner({});
  const candidates = new Set<string>();
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), "lost-vault-delete-"));
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
    resolve: {
      alias: [
        {
          find: "@capacitor/core",
          replacement: path.join(root, "e2e/fixtures/lost-vault-delete-boundaries.tsx"),
          // Keep session bootstrap on this fixture's synthetic web transport.
          // The native variant covers phone UI, not native session restoration.
          customResolver: (source, importer) => importer?.endsWith("/lib/firebase/auth-context.tsx")
            ? path.join(root, "e2e/fixtures/profile-sign-out-boundaries.ts")
            : source,
        },
        {
          find: /^(?:(?:.*\/)?(?:auth-service|api-service|account-identity-service)(?:\.ts)?|\.\.\/capacitor|\.\/config)$/,
          replacement: path.join(
            root,
            "e2e/fixtures/lost-vault-delete-boundaries.tsx",
          ),
        },
        ...[
          "firebase/auth",
          "@/lib/firebase/config",
          "@/lib/services/auth-service",
          "@/lib/services/api-service",
          "@/lib/notifications/fcm-service",
          "@/lib/services/account-identity-service",
          "@/lib/cache/cache-sync-service",
          "@/lib/services/user-local-state-service",
          "@/lib/services/onboarding-local-service",
          "@/lib/services/onboarding-route-cookie",
          "@/lib/utils/session-storage",
          "@/lib/observability/identity",
          "@/lib/connected-systems/crm-product-availability",
          "@/lib/capacitor/session-privacy",
          "@/lib/interaction/interaction-intent-coordinator",
          "@/lib/agent/one-conversation-session",
          "next/navigation",
          "@/lib/agent/local-onboarding-actions",
          "@/lib/kai/actions/voice-surface-metadata",
          "@/lib/capacitor",
          "@/lib/services/vault-service",
          "@/lib/observability/client",
          "@/components/onboarding/AuthStep",
          "@/components/app-ui/native-route-marker",
          "sonner",
        ].map((find) => ({
          find: new RegExp(`^${find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`),
          replacement: path.join(
            root,
            "e2e/fixtures/lost-vault-delete-boundaries.tsx",
          ),
        })),
        { find: "@", replacement: root },
      ],
    },
    define: {
      "process.env.NODE_ENV": JSON.stringify("production"),
      "process.env": "{}",
    },
    build: {
      outDir,
      emptyOutDir: false,
      lib: {
        entry: path.join(root, "e2e/fixtures/lost-vault-delete.tsx"),
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
  css =
    stripAppFontFaces(compiler.build([...candidates])) +
    productFontStyle() +
    fs
      .readdirSync(outDir)
      .filter((name) => name.endsWith(".css"))
      .map((name) => fs.readFileSync(path.join(outDir, name), "utf8"))
      .join("\n");
});

test.afterAll(() => {
  if (outDir) fs.rmSync(outDir, { recursive: true, force: true });
});

for (const viewport of [
  { width: 393, height: 852, native: false },
  { width: 393, height: 852, native: true },
  { width: 1440, height: 900, native: false },
]) {
  for (const outcome of ["identity_retained", "quarantined", "deleted", "pending"]) {
    test(`lost-vault proof and terminal ${outcome} at ${viewport.width}px ${viewport.native ? "native" : "web"}`, async ({
      page,
    }, testInfo) => {
      const events: string[] = [];
      const errors: string[] = [];
      const navigations: string[] = [];
      page.on("framenavigated", (frame) => {
        if (frame === page.mainFrame()) navigations.push(frame.url());
      });
      page.on("pageerror", (error) => errors.push(error.message));
      await page.exposeFunction("recordSignOutEvent", (event: string) => {
        events.push(event);
      });
      await page.setViewportSize(viewport);
      await page.route("https://lost-vault.test/**", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body><div id="root"></div><script>${script.replace(/<\/script/gi, "<\\/script")}</script></body></html>`,
        }),
      );
      await page.goto(`https://lost-vault.test/one/connect?outcome=${outcome}&native=${viewport.native ? "1" : "0"}`);
      await awaitProductFont(page);
      const warning = page.getByText(
        "Deletes vault and files. Revoke bank access; required records may remain.",
      );
      await expect(warning).toBeVisible();
      expect(await warning.evaluate((element) => {
        const { height } = element.getBoundingClientRect();
        const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight);
        return Math.round(height / lineHeight);
      })).toBeLessThanOrEqual(2);
      await page.getByRole("button", { name: "Continue with Google" }).click();
      const phone = page.getByLabel("Mobile number");
      await expect(phone).toHaveValue("");
      await page
        .getByRole("button", { name: "Country code: United States (+1)" })
        .click();
      await page
        .getByRole("searchbox", { name: "Search countries" })
        .fill("United States");
      await page
        .getByRole("button", { name: "United States (+1)", exact: true })
        .click();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await page.screenshot({
        path: testInfo.outputPath(`phone-${viewport.width}.png`),
      });
      // Same final digits must not be accepted as proof of the complete number.
      await phone.fill("+12125550100");
      await page
        .getByRole("button", { name: "Send code", exact: true })
        .click();
      await expect(page.getByRole("alert")).toContainText("does not match");
      expect(events).not.toContain("sms-requested");
      await phone.fill("+16505550100");
      await page
        .getByRole("button", { name: "Send code", exact: true })
        .click();
      await page.getByLabel("Verification code").fill("111111");
      await page
        .getByRole("button", { name: "Verify code", exact: true })
        .click();
      await expect(page.getByRole("alert")).toContainText("incorrect");
      await page.getByLabel("Verification code").fill("123456");
      await page
        .getByRole("button", { name: "Verify code", exact: true })
        .click();
      const deletion = page.getByRole("button", {
        name: "Permanently delete account",
      });
      await expect(deletion).toBeDisabled();
      expect(events).not.toContain("deletion-submitted");
      await page.getByRole("checkbox").check();
      await page.screenshot({
        path: testInfo.outputPath(`confirm-${viewport.width}.png`),
      });
      await deletion.click();
      const notice =
        outcome === "pending"
          ? "account_deletion_requested"
          : outcome === "identity_retained"
          ? "account_deletion_identity_retained"
          : outcome === "deleted"
            ? "account_deleted_ready_to_start_fresh"
            : "account_deletion_finishing";
      await expect
        .poll(() => events.includes("credentials-cleared"))
        .toBe(true);
      // A real document replacement must preserve the central outcome notice.
      await expect(page.getByRole("status")).toContainText(
        outcome === "identity_retained"
          ? "will not be removed automatically"
          : outcome === "deleted"
            ? "start fresh"
            : outcome === "pending"
              ? "Deletion requested. Cleanup continues"
            : "Account removal still needs attention",
      );
      await expect(page).toHaveURL("https://lost-vault.test/login"); // login consumes its typed notice.
      expect(
        events.filter((event) => event === "deletion-submitted"),
      ).toHaveLength(1);
      expect(events).toContain(outcome === "pending" ? "local-state-cleared" : "device-secrets-cleared");
      expect(events.indexOf("preflight-accepted")).toBeLessThan(
        events.indexOf("sms-requested"),
      );
      expect(events.indexOf("phone-verified")).toBeLessThan(
        events.indexOf("deletion-submitted"),
      );
      expect(events.indexOf("provider-inventory-reviewed")).toBeLessThan(
        events.indexOf("deletion-submitted"),
      );
      await expect(
        page.getByRole("link", { name: "Create a new account" }),
      ).toHaveCount(0);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      expect(errors).toEqual([]);
      expect(navigations).toContain(
        `https://lost-vault.test/login?auth_notice=${notice}`,
      );
      await page.screenshot({
        path: testInfo.outputPath(`outcome-${viewport.width}.png`),
      });
    });
  }
}
