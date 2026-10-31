import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ACTIVE_SHARE_ACTIONS_CLASSNAME,
  ACTIVE_SHARE_CHANGE_TIME_CLASSNAME,
  ACTIVE_SHARE_LANE_ACTIONS_CLASSNAME,
  ACTIVE_SHARE_LANE_ROW_CLASSNAME,
  ACTIVE_SHARE_STOP_CLASSNAME,
} from "../components/one-location/redesign/active-share-row-layout";
import { awaitProductFont, productFontStyle, stripAppFontFaces } from "./fixtures/product-font";

const WIDTHS = [320, 360, 393, 430, 600, 767, 768, 832, 1280] as const;
const SINGLE_ROW_CLASSNAME =
  "relative isolate grid w-full min-h-[72px] grid-cols-1 gap-y-1 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-x-3 sm:gap-y-0";
const SINGLE_TRAILING_CLASSNAME =
  "relative flex max-w-full shrink-0 items-center justify-end self-center gap-2.5 w-full min-w-0 pl-[52px] pt-1 sm:w-auto sm:pl-0 sm:pt-0";

async function buildFixture(): Promise<string> {
  const webappRoot = process.cwd();
  const { compile } = (await import(
    path.join(webappRoot, "node_modules/tailwindcss/dist/lib.mjs")
  )) as {
    compile: (
      css: string,
      options: unknown,
    ) => Promise<{ build: (classes: string[]) => string }>;
  };
  const compiler = await compile('@import "tailwindcss";', {
    base: path.join(webappRoot, "node_modules"),
    onDependency: () => {},
    loadStylesheet: async (id: string, base: string) => {
      const file =
        id === "tailwindcss"
          ? path.join(webappRoot, "node_modules/tailwindcss/index.css")
          : path.resolve(base, id);
      return {
        path: file,
        base: path.dirname(file),
        content: fs.readFileSync(file, "utf8"),
      };
    },
  });
  const harness =
    "mx-auto w-full max-w-[1040px] p-4 rounded-[24px] min-w-0 flex-1 text-[15px] text-[13px] font-medium truncate";
  const candidates = [
    ACTIVE_SHARE_ACTIONS_CLASSNAME,
    ACTIVE_SHARE_CHANGE_TIME_CLASSNAME,
    ACTIVE_SHARE_LANE_ACTIONS_CLASSNAME,
    ACTIVE_SHARE_LANE_ROW_CLASSNAME,
    ACTIVE_SHARE_STOP_CLASSNAME,
    SINGLE_ROW_CLASSNAME,
    SINGLE_TRAILING_CLASSNAME,
    harness,
  ]
    .join(" ")
    .split(/\s+/)
    .filter(Boolean);

  const controls = (kind: "single" | "lane") => `
    <div data-actions="${kind}" class="${
      kind === "single"
        ? ACTIVE_SHARE_ACTIONS_CLASSNAME
        : ACTIVE_SHARE_LANE_ACTIONS_CLASSNAME
    }">
      <button data-change="${kind}" class="${ACTIVE_SHARE_CHANGE_TIME_CLASSNAME}">Change time</button>
      <button data-stop="${kind}" class="${ACTIVE_SHARE_STOP_CLASSNAME}">Stop</button>
    </div>`;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "active-share-actions-"));
  fs.writeFileSync(path.join(dir, "fixture.css"), compiler.build(candidates));
  fs.writeFileSync(
    path.join(dir, "fixture.html"),
    `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="fixture.css"><style>${productFontStyle()}</style>
</head><body style="margin:0"><main class="p-4">
  <section data-card="single" class="mx-auto w-full max-w-[1040px] rounded-[24px]">
    <div data-row="single" class="${SINGLE_ROW_CLASSNAME}">
      <div data-copy="single" class="min-w-0 flex-1">
        <p class="truncate text-[15px] font-medium">Smirthika Dharmalingam with a deliberately long name</p>
        <p class="truncate text-[13px]">Active · Location share · 14:48 left</p>
      </div>
      <div data-trailing="single" class="${SINGLE_TRAILING_CLASSNAME}">${controls("single")}</div>
    </div>
  </section>
  <section data-card="lane" class="mx-auto w-full max-w-[1040px] p-4 rounded-[24px]">
    <div data-row="lane" class="${ACTIVE_SHARE_LANE_ROW_CLASSNAME}">
      <div data-copy="lane" class="min-w-0 flex-1">
        <p class="truncate text-[15px] font-medium">Location share</p>
        <p class="truncate text-[13px]">14:48 left</p>
      </div>
      ${controls("lane")}
    </div>
  </section>
</main></body></html>`,
  );
  return `file://${path.join(dir, "fixture.html")}`;
}

test.describe("active share action alignment", () => {
  for (const width of WIDTHS) {
    test(`keeps Change time beside Stop without overflow at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(await buildFixture());
      await awaitProductFont(page);

      const result = await page.evaluate(() => {
        const rect = (selector: string) =>
          document.querySelector<HTMLElement>(selector)!.getBoundingClientRect().toJSON();
        return {
          overflow:
            document.documentElement.scrollWidth -
            document.documentElement.clientWidth,
          rows: (["single", "lane"] as const).map((kind) => ({
            row: rect(`[data-row="${kind}"]`),
            copy: rect(`[data-copy="${kind}"]`),
            actions: rect(`[data-actions="${kind}"]`),
            change: rect(`[data-change="${kind}"]`),
            stop: rect(`[data-stop="${kind}"]`),
          })),
        };
      });

      expect(result.overflow).toBeLessThanOrEqual(1);
      for (const row of result.rows) {
        expect(row.change.height).toBeGreaterThanOrEqual(44);
        expect(row.stop.height).toBeGreaterThanOrEqual(44);
        expect(row.change.right).toBeLessThanOrEqual(row.stop.left + 1);
        expect(Math.abs(row.change.top - row.stop.top)).toBeLessThanOrEqual(1);
        expect(row.actions.left).toBeGreaterThanOrEqual(row.row.left - 1);
        expect(row.actions.right).toBeLessThanOrEqual(row.row.right + 1);

        if (width < 640) {
          expect(row.actions.top).toBeGreaterThanOrEqual(row.copy.bottom - 1);
          expect(Math.abs(row.change.left - row.actions.left)).toBeLessThanOrEqual(1);
          expect(Math.abs(row.stop.right - row.actions.right)).toBeLessThanOrEqual(1);
        } else {
          expect(row.copy.right).toBeLessThanOrEqual(row.actions.left + 1);
          expect(row.stop.left - row.change.right).toBeLessThanOrEqual(16);
        }
      }
    });
  }
});

test.describe("production Manage sharing comparison and Now banner", () => {
  let script = "";
  let css = "";
  test.beforeAll(async () => {
    const root = process.cwd();
    const { build } = await import("vite");
    const { Scanner } = await import("@tailwindcss/oxide");
    const scanner = new Scanner({});
    const candidates = new Set<string>();
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "location-sharing-layout-"));
    await build({
      configFile: false,
      publicDir: false,
      logLevel: "error",
      oxc: { jsx: { runtime: "automatic" } },
      plugins: [{ name: "sharing-css-candidates", transform(source, id) {
        if (!id.includes("node_modules") && /\.[tj]sx?$/.test(id)) {
          for (const candidate of scanner.scanFiles([{ content: source, extension: "tsx" }])) candidates.add(candidate);
        }
      } }],
      resolve: { alias: [{ find: "@", replacement: root }] },
      define: { "process.env.NODE_ENV": JSON.stringify("production"), "process.env": "{}" },
      build: { outDir, emptyOutDir: false, lib: {
        entry: path.join(root, "e2e/fixtures/location-sharing.tsx"), name: "SharingFixture", formats: ["iife"], fileName: () => "fixture.js",
      } },
    });
    script = fs.readFileSync(path.join(outDir, "fixture.js"), "utf8");
    const { compile } = await import("tailwindcss");
    const compiler = await compile(fs.readFileSync(path.join(root, "app/globals.css"), "utf8").replace(/^@source\s+[^;]+;\s*$/gm, ""), {
      base: path.join(root, "app"),
      loadStylesheet: async (id, base) => {
        const file = id === "tailwindcss" ? path.join(root, "node_modules/tailwindcss/index.css")
          : id === "tw-animate-css" ? path.join(root, "node_modules/tw-animate-css/dist/tw-animate.css") : path.resolve(base, id);
        return { path: file, base: path.dirname(file), content: fs.readFileSync(file, "utf8") };
      },
    });
    css = stripAppFontFaces(compiler.build([...candidates])) + productFontStyle();
  });

  async function openSharing(page: Page, width: number, theme: "light" | "dark", accent = "blue") {
    await page.setViewportSize({ width, height: 1000 });
    await page.route("http://localhost/location-sharing-fixture", (route) => route.fulfill({ contentType: "text/html",
      body: `<!doctype html><html class="${theme === "dark" ? "dark" : ""}" data-accent="${accent}"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div></body></html>`,
    }));
    await page.goto("http://localhost/location-sharing-fixture");
    await page.addScriptTag({ content: script });
    await expect(page.getByTestId("one-location-share-comparison")).toBeVisible();
    await awaitProductFont(page);
  }

  for (const width of WIDTHS) for (const theme of ["light", "dark"] as const) {
    test(`keeps each share and its actions aligned at ${width}px in ${theme}`, async ({ page }) => {
      await openSharing(page, width, theme);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(1);
      const lanes = page.getByTestId("one-location-share-lane");
      for (const lane of await lanes.all()) {
        const box = await lane.boundingBox();
        for (const button of await lane.getByRole("button").all()) {
          const control = await button.boundingBox();
          expect(control!.height).toBeGreaterThanOrEqual(44);
          expect(control!.x).toBeGreaterThanOrEqual(box!.x - 1);
          expect(control!.x + control!.width).toBeLessThanOrEqual(box!.x + box!.width + 1);
          expect(await button.evaluate((node) => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
        }
      }
      const location = page.locator('[data-grant-id="0_share"]');
      const sms = page.locator('[data-grant-id="0_sos"]');
      await expect(location.getByRole("button", { name: /Stop the location share/ })).toHaveText("Stopping…");
      await expect(location.getByRole("button", { name: /Stop the location share/ })).toBeDisabled();
      await expect(sms.getByRole("button")).toBeEnabled();
      const left = await location.boundingBox();
      const right = await sms.boundingBox();
      const mode = await page.getByTestId("one-location-share-comparison").getAttribute("data-share-layout");
      if (mode === "comparison") {
        expect(right!.x).toBeGreaterThanOrEqual(left!.x + left!.width);
      } else {
        expect(right!.y).toBeGreaterThanOrEqual(left!.y + left!.height);
        await expect(page.getByTestId("one-location-ordinary-shares").getByTestId("one-location-share-lane")).toHaveCount(3);
        await expect(page.getByTestId("one-location-sms-shares").getByTestId("one-location-share-lane")).toHaveCount(4);
        await expect(page.getByTestId("one-location-sms-shares").getByRole("button", { name: /Change end time/ })).toHaveCount(0);
      }
      await expect(page.getByTestId("one-location-location-count")).toHaveText("3 Location shares");
      await expect(page.getByTestId("one-location-sms-count")).toHaveText("4 SMS");
      await expect(page.getByTestId("one-location-overlap-count")).toHaveText("1 person receives both");
      await sms.getByRole("button").click();
      await expect(sms).toHaveCount(0);
      await expect(location).toBeVisible();
      await expect(page.getByTestId("one-location-sms-count")).toHaveText("3 SMS");
      await expect(page.getByTestId("one-location-overlap-count")).toHaveCount(0);
      await expect(page.locator('[data-ui-id="location-live-share-title"]')).toHaveText("Sharing with 6 people");
    });
  }

  test("follows the current font and optional gold accent", async ({ page }) => {
    await openSharing(page, 393, "dark", "gold");
    const button = page.getByTestId("one-location-live-share-more");
    const style = await button.evaluate((node) => ({
      font: getComputedStyle(node).fontFamily,
      fill: getComputedStyle(node).backgroundColor,
      accent: (() => {
        const probe = document.createElement("span");
        probe.style.backgroundColor = "var(--app-accent)";
        document.body.append(probe);
        const color = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return color;
      })(),
    }));
    expect(style.font).toContain("Plus Jakarta Sans");
    expect(style.accent).toBeTruthy();
    expect(style.fill).toBe(style.accent);
    const surface = await page.getByTestId("one-location-live-share").evaluate((node) => {
      const expected = document.createElement("span");
      expected.style.backgroundColor = "var(--app-primary-surface)";
      document.body.append(expected);
      const token = getComputedStyle(expected).backgroundColor;
      expected.remove();
      return { token, actual: getComputedStyle(node).backgroundColor };
    });
    expect(surface.actual).toBe(surface.token);
    await button.click();
    await expect(page.locator("body")).toHaveAttribute("data-last-action", "share");
  });
});
