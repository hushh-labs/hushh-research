import { expect, test } from "@playwright/test";
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
import { awaitProductFont, productFontStyle } from "./fixtures/product-font";

const WIDTHS = [320, 360, 393, 430, 600, 768, 1280] as const;
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
        } else {
          expect(row.copy.right).toBeLessThanOrEqual(row.actions.left + 1);
        }
      }
    });
  }
});
