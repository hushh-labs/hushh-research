import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { productFontStyle, stripAppFontFaces } from "./fixtures/product-font";

/**
 * The contact list a person picks from after a contact sync, measured in a
 * real browser with the real sheet primitive and the real app stylesheet.
 *
 * JSDOM performs no layout, so the defect this guards is invisible to a class
 * assertion: the list under "Search contacts…" collapsed to a sliver. The
 * sheet capped itself at `88dvh - keyboard` while the primitive already lifts
 * it above the keyboard, so the keyboard was subtracted twice, and the search
 * field scrolled away inside the same box as the rows it filters. With the
 * keyboard up on a small phone, the rows got a few pixels.
 *
 * Run with: npm run test:layout-contracts
 */

let css: string;
let script: string;

test.beforeAll(async () => {
  const root = process.cwd();
  const { build } = await import("vite");
  const { Scanner } = await import("@tailwindcss/oxide");
  const scanner = new Scanner({});
  const candidates = new Set<string>();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "contact-invite-"));
  await build({
    configFile: false,
    logLevel: "error",
    plugins: [
      {
        name: "contact-invitation-boundaries",
        load(id) {
          if (id === "\0fixture-contact-signals")
            return `export function describeContactSyncOutcome() { return { title: "No eligible contacts matched", remedy: "invite" }; }`;
          if (id === "\0fixture-invitations-service")
            return `export const ContactInvitationsService = { canComposeSms: async () => false };
            export function invitationBody() { return ""; }
            export function assertInvitationShare() {}`;
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
    oxc: { jsx: { runtime: "automatic", development: false } },
    resolve: {
      alias: [
        {
          find: "@/lib/one-location/contact-signals",
          replacement: "\0fixture-contact-signals",
        },
        {
          find: "@/lib/services/contact-invitations-service",
          replacement: "\0fixture-invitations-service",
        },
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
        entry: path.join(root, "e2e/fixtures/contact-invitation-sheet.tsx"),
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

async function mount(page: Page, keyboardPx: number) {
  await page.setContent(
    `<html style="--kb-height:${keyboardPx}px"><head><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><style>${css}</style></head><body><div id="root"></div></body></html>`,
  );
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addScriptTag({ content: script });
  await expect(
    page.getByRole("dialog", { name: "Invite your contacts" }),
  ).toBeVisible();
  // Measure the settled sheet, not its slide-in frame.
  await page.evaluate(() =>
    Promise.all(
      document.getAnimations().map((animation) => animation.finished),
    ),
  );
  expect(errors).toEqual([]);
}

function measure(page: Page) {
  return page.evaluate(() => {
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    const search = document.querySelector<HTMLElement>(
      'input[aria-label="Search contacts to invite"]',
    )!;
    const list = document.querySelector<HTMLElement>(
      "[data-contact-invite-list]",
    );
    const rows = [...document.querySelectorAll<HTMLElement>("li")];
    const sheet = dialog.getBoundingClientRect();
    const box = (list ?? dialog).getBoundingClientRect();
    const fullyVisibleRows = rows.filter((row) => {
      const rect = row.getBoundingClientRect();
      return (
        rect.top >= Math.max(box.top, 0) - 0.5 &&
        rect.bottom <= Math.min(box.bottom, window.innerHeight) + 0.5
      );
    }).length;
    return {
      sheetTop: sheet.top,
      sheetBottom: sheet.bottom,
      searchTop: search.getBoundingClientRect().top,
      searchBottom: search.getBoundingClientRect().bottom,
      listHeight: list ? list.clientHeight : 0,
      listScrollable: list ? list.scrollHeight > list.clientHeight : false,
      fullyVisibleRows,
    };
  });
}

// Phone widths the app ships to, a keyboard-sized inset, and desktop.
const CASES = [
  { name: "iPhone SE", width: 320, height: 568, keyboard: 0 },
  { name: "iPhone SE, keyboard up", width: 320, height: 568, keyboard: 260 },
  { name: "iPhone 8, keyboard up", width: 375, height: 667, keyboard: 291 },
  { name: "iPhone 15", width: 393, height: 852, keyboard: 0 },
  { name: "iPhone 15, keyboard up", width: 393, height: 852, keyboard: 336 },
  { name: "desktop", width: 1440, height: 900, keyboard: 0 },
] as const;

for (const viewport of CASES) {
  test(`contact list stays readable and scrollable: ${viewport.name}`, async ({
    page,
  }) => {
    await page.setViewportSize({
      width: viewport.width,
      height: viewport.height,
    });
    await mount(page, viewport.keyboard);
    const before = await measure(page);

    // The sheet sits inside the space above the keyboard...
    expect(before.sheetTop).toBeGreaterThanOrEqual(0);
    expect(before.sheetBottom).toBeLessThanOrEqual(
      viewport.height - viewport.keyboard + 0.5,
    );
    // ...and, with the keyboard up, uses it: it reaches the 1rem top gap. The
    // old `88dvh - keyboard` cap subtracted the keyboard twice and left 68-80px
    // of dead space above the sheet on these phones.
    if (viewport.keyboard > 0)
      expect(before.sheetTop).toBeLessThanOrEqual(16.5);

    // The rows are their own scroller, never a sliver: at least one full 56px
    // row of height in the worst case (it was 24px), and whole contacts on
    // screen whenever the keyboard is down.
    expect(before.listScrollable).toBe(true);
    expect(before.listHeight).toBeGreaterThanOrEqual(56);
    if (viewport.keyboard === 0) {
      expect(before.fullyVisibleRows).toBeGreaterThanOrEqual(3);
    }

    // Scrolling the rows leaves the field that filters them in place.
    await page
      .locator("[data-contact-invite-list]")
      .evaluate((list) => list.scrollTo({ top: list.scrollHeight }));
    const after = await measure(page);
    expect(after.searchTop).toBeCloseTo(before.searchTop, 0);
    expect(after.searchBottom).toBeLessThanOrEqual(
      viewport.height - viewport.keyboard,
    );
  });
}

test.describe("contact sync notification", () => {
  test.use({ hasTouch: true });
  for (const input of ["click", "tap"] as const) {
    test(`Invite them opens the invitation session via ${input}`, async ({
      page,
    }) => {
      await page.setViewportSize(
        input === "tap"
          ? { width: 393, height: 852 }
          : { width: 1440, height: 900 },
      );
      await page.setContent(
        `<html data-sync-notification="true"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body><div id="root"></div></body></html>`,
      );
      await page.addScriptTag({ content: script });
      await expect(
        page.getByRole("dialog", { name: "Contact sync results" }),
      ).toBeVisible();
      const action = page
        .locator("[data-sonner-toaster]")
        .getByRole("button", { name: "Invite them", exact: true });
      await action[input]();
      await expect(
        page.getByRole("dialog", { name: "Invite your contacts" }),
      ).toBeVisible();
      await expect(
        page.getByText("Contact person 1", { exact: true }),
      ).toBeVisible();
    });
  }
});
