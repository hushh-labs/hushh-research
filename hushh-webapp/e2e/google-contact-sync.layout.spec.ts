import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { productFontStyle, stripAppFontFaces } from "./fixtures/product-font";

let css: string;
let script: string;
test.beforeAll(async () => {
  const root = process.cwd();
  const { build } = await import("vite");
  const { Scanner } = await import("@tailwindcss/oxide");
  const scanner = new Scanner({});
  const candidates = new Set<string>();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "google-contact-sync-"));
  await build({
    configFile: false,
    logLevel: "error",
    plugins: [
      {
        name: "google-contact-sync-test-boundaries",
        load(id) {
          if (id === "\0fixture-capacitor")
            return "export const HushhContacts = {};";
          if (id === "\0fixture-signals")
            return `export async function syncOneLocationContactSignals(options) {
            globalThis.contactFixture.syncCalls++;
            const read = await options.source({limit: 500});
            return {matches: [], matchedUserIds: [], totalContacts: read.contacts.length,
              readContactCount: read.contacts.length, checkedContactCount: 0, matchedContactCount: 0,
              unmatchedContactCount: 0, uncheckedContactCount: 0, uncheckableContactCount: 0,
              excludedSelfContactCount: 0, lookupLimitedContactCount: 0, lookupLimitExceeded: false,
              inviteCandidateCount: 0, autoConnectedCount: 0, alreadyConnectedCount: 0,
              requestRequiredCount: 0, suppressedCount: 0, unknownContactCount: 0,
              completedBatchCount: 0, totalBatchCount: 0, mutationOutcomeUnknown: false,
              sourcePlatform: "google", limited: false, truncated: false, partial: false, region: null};
          }`;
          if (id === "\0fixture-cache")
            return "export const CacheSyncService = { onConnectionGraphMutated() {} };";
          if (id === "\0fixture-analytics")
            return "export function trackEvent() {}";
          if (id === "\0fixture-platform")
            return "export function isNative() { return false; }";
          if (id === "\0fixture-invitations")
            return "export function ContactInvitationSheet() { return null; }";
        },
      },
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
    oxc: { jsx: { runtime: "automatic" } },
    resolve: {
      alias: [
        {
          find: "@/lib/one-location/contact-signals",
          replacement: "\0fixture-signals",
        },
        {
          find: "@/lib/cache/cache-sync-service",
          replacement: "\0fixture-cache",
        },
        {
          find: "@/lib/observability/client",
          replacement: "\0fixture-analytics",
        },
        { find: "@/lib/capacitor/platform", replacement: "\0fixture-platform" },
        { find: "@/lib/capacitor", replacement: "\0fixture-capacitor" },
        {
          find: "@/components/connections/contact-invitation-sheet",
          replacement: "\0fixture-invitations",
        },
        { find: "@", replacement: root },
      ],
    },
    define: {
      "process.env.NODE_ENV": JSON.stringify("production"),
      "process.env.NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID": JSON.stringify(
        "fixture.apps.googleusercontent.com",
      ),
      "process.env": "{}",
    },
    build: {
      outDir,
      emptyOutDir: false,
      lib: {
        entry: path.join(root, "e2e/fixtures/google-contact-sync.tsx"),
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
  css = stripAppFontFaces(compiler.build([...candidates])) + productFontStyle();
});

test.beforeEach(async ({ page }) => {
  await page.route("https://people.googleapis.com/**", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ connections: [], totalPeople: 0 }),
      headers: { "access-control-allow-origin": "*" },
    }),
  );
  await page.setContent(
    `<html><head><style>${css}</style></head><body><div id="root"></div></body></html>`,
  );
  const startupErrors: string[] = [];
  page.on("pageerror", (error) => startupErrors.push(error.message));
  await page.addScriptTag({ content: script });
  expect(startupErrors).toEqual([]);
});

for (const width of [393, 1440]) {
  test(`Google result survives gate remount at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page
      .getByRole("button", { name: "Find contacts", exact: true })
      .click();
    await expect(
      page.getByRole("dialog", { name: "Connect Google Contacts" }),
    ).toBeVisible();
    await page.evaluate(() =>
      (
        globalThis as unknown as {
          contactFixture: { block: (value: boolean) => void };
        }
      ).contactFixture.block(true),
    );
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.evaluate(() =>
      (
        globalThis as unknown as {
          contactFixture: {
            block: (value: boolean) => void;
            consent: (cancelled?: boolean) => void;
          };
        }
      ).contactFixture.consent(),
    );
    await page.evaluate(() =>
      (
        globalThis as unknown as {
          contactFixture: {
            block: (value: boolean) => void;
            consent: (cancelled?: boolean) => void;
          };
        }
      ).contactFixture.block(false),
    );
    const results = page.getByRole("dialog", { name: "Contact sync results" });
    await expect(results).toBeVisible();
    await expect(
      results.getByText("No saved Google contacts found"),
    ).toBeVisible();
    await expect(
      results.getByRole("link", { name: "Check Google Contacts" }),
    ).toBeVisible();
    await expect(
      results.getByRole("button", { name: "Choose Google account" }),
    ).toBeVisible();
    await expect(
      results.getByRole("button", { name: "Choose Google account" }),
    ).toHaveClass(/bg-\[color:var\(--app-accent\)\]/);
    await expect(
      results.getByRole("button", { name: "Invite contacts" }),
    ).toHaveCount(0);
    await expect(results.getByText("Checked", { exact: true })).toHaveCount(0);
    // Radix becomes visible at the start of its slide animation. Wait until
    // the entire sheet, including recovery actions, is inside the viewport.
    await expect
      .poll(async () => {
        const bounds = await results.boundingBox();
        return bounds ? Math.round(bounds.y + bounds.height) : Infinity;
      })
      .toBeLessThanOrEqual(901);
    const box = (await results.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
    expect(
      await page.evaluate(
        () =>
          (globalThis as unknown as { contactFixture: unknown }).contactFixture,
      ),
    ).toMatchObject({ syncCalls: 1, tokenCalls: 1, activation: [true] });
    expect(errors).toEqual([]);
    await testInfo.attach("Google contact results", {
      body: await page.screenshot({
        path: testInfo.outputPath("google-results.png"),
      }),
      contentType: "image/png",
    });
  });
}

test("closing Google keeps an actionable cancellation screen and explicit retry", async ({
  page,
}) => {
  await page
    .getByRole("button", { name: "Find contacts", exact: true })
    .click();
  await page.evaluate(() =>
    (
      globalThis as unknown as {
        contactFixture: {
          block: (value: boolean) => void;
          consent: (cancelled?: boolean) => void;
        };
      }
    ).contactFixture.consent(true),
  );
  const cancellation = page.getByRole("dialog", {
    name: "Contact sync cancelled",
  });
  await expect(cancellation).toBeVisible();
  await cancellation
    .getByRole("button", { name: "Choose Google account" })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Connect Google Contacts" }),
  ).toBeVisible();
  await page.evaluate(() =>
    (
      globalThis as unknown as {
        contactFixture: {
          block: (value: boolean) => void;
          consent: (cancelled?: boolean) => void;
        };
      }
    ).contactFixture.consent(),
  );
  await expect(
    page.getByRole("dialog", { name: "Contact sync results" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        (globalThis as unknown as { contactFixture: unknown }).contactFixture,
    ),
  ).toMatchObject({ syncCalls: 1, tokenCalls: 2, activation: [true, true] });
});
