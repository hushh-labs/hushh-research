import { expect, test } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  awaitProductFont,
  productFontStyle,
} from "./fixtures/product-font";
import {
  DURATION_COMPACT_CELL_CLASS,
  DURATION_COMPACT_GRID_CLASS,
  DURATION_CELL_CLASS,
  DURATION_CELL_OFF_CLASS,
  DURATION_CELL_ON_CLASS,
} from "../components/one-location/redesign/duration-presets";
import {
  DURATION_EQUAL_BUTTON_CLASSNAME,
  DURATION_EQUAL_BUTTONS_GROUP_CLASSNAME,
  PUBLIC_LINK_CONTROLS_CLASSNAME,
  PUBLIC_LINK_PRIMARY_CTA_CLASSNAME,
  SHARE_CONFIRM_ACTIONS_CLASSNAME,
  SHARE_CONFIRM_PRIMARY_CTA_CLASSNAME,
} from "../components/one-location/redesign/location-cta-layout";
import {
  LOCATION_HEADER_ACTIONS_CLASSNAME,
  LOCATION_HEADER_STATUS_CLASSNAME,
} from "../components/one-location/redesign/location-header-layout";
import { cn } from "../lib/utils";

const WIDTHS = [320, 360, 393, 430, 600, 768] as const;
const STATUS_LABELS = [
  "Location on",
  "Location off",
  "Location blocked",
] as const;

const EQUAL_OPTION_CLASSNAME = cn(
  "h-9 rounded-full border px-4 transition-colors touch-manipulation",
  DURATION_EQUAL_BUTTON_CLASSNAME,
  DURATION_CELL_OFF_CLASS,
);
const COMPACT_CELL_ON_CLASSNAME = cn(
  DURATION_CELL_CLASS,
  DURATION_COMPACT_CELL_CLASS,
  DURATION_CELL_ON_CLASS,
);
const COMPACT_CELL_OFF_CLASSNAME = cn(
  DURATION_CELL_CLASS,
  DURATION_COMPACT_CELL_CLASS,
  DURATION_CELL_OFF_CLASS,
);

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

  const harnessClasses =
    "p-4 p-5 mx-auto w-full max-w-[560px] flex items-center gap-3 h-11 w-11 " +
    "min-w-0 flex-1 whitespace-nowrap text-[28px] font-semibold inline-flex justify-center h-8 w-[51px] rounded-full";
  const classes = [
    PUBLIC_LINK_CONTROLS_CLASSNAME,
    PUBLIC_LINK_PRIMARY_CTA_CLASSNAME,
    SHARE_CONFIRM_ACTIONS_CLASSNAME,
    SHARE_CONFIRM_PRIMARY_CTA_CLASSNAME,
    DURATION_EQUAL_BUTTONS_GROUP_CLASSNAME,
    EQUAL_OPTION_CLASSNAME,
    DURATION_COMPACT_GRID_CLASS,
    COMPACT_CELL_ON_CLASSNAME,
    COMPACT_CELL_OFF_CLASSNAME,
    LOCATION_HEADER_ACTIONS_CLASSNAME,
    LOCATION_HEADER_STATUS_CLASSNAME,
    harnessClasses,
  ]
    .join(" ")
    .split(/\s+/)
    .filter(Boolean);

  const compactOptions = ["15 min", "1 hour", "Custom", "Until I stop"]
    .map(
      (label, index) =>
        `<button data-share-option class="${index === 0 ? COMPACT_CELL_ON_CLASSNAME : COMPACT_CELL_OFF_CLASSNAME}">${label}</button>`,
    )
    .join("");
  const headers = STATUS_LABELS.map(
    (label) => `<header data-header class="flex items-center gap-3">
      <span class="h-11 w-11 shrink-0 rounded-[10px]"></span>
      <h1 data-header-title class="min-w-0 flex-1 whitespace-nowrap text-[28px] font-semibold">Location</h1>
      <div data-header-actions class="${LOCATION_HEADER_ACTIONS_CLASSNAME}">
        <button data-header-switch class="h-8 w-[51px] shrink-0 rounded-full"></button>
        <span data-header-status class="${LOCATION_HEADER_STATUS_CLASSNAME}">${label}</span>
      </div>
    </header>`,
  ).join("");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "location-cta-layout-"));
  fs.writeFileSync(path.join(dir, "fixture.css"), compiler.build(classes));
  fs.writeFileSync(
    path.join(dir, "fixture.html"),
    `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="fixture.css">
<style>${productFontStyle()}</style></head><body style="margin:0">
<main class="p-4">
  <section data-public-card class="mx-auto w-full max-w-[560px] p-4">
    <div data-public-controls class="${PUBLIC_LINK_CONTROLS_CLASSNAME}">
      <div class="space-y-2.5">
        <p>Duration</p>
        <div data-public-options class="${DURATION_EQUAL_BUTTONS_GROUP_CLASSNAME}">
          <button data-public-option class="${EQUAL_OPTION_CLASSNAME}">30 min</button>
          <button data-public-option class="${EQUAL_OPTION_CLASSNAME}">1 hour</button>
        </div>
      </div>
      <button data-public-cta class="${PUBLIC_LINK_PRIMARY_CTA_CLASSNAME} inline-flex items-center justify-center">Create link</button>
    </div>
  </section>
  <section data-share-card class="mx-auto w-full max-w-[560px] p-5">
    <div data-share-options class="${DURATION_COMPACT_GRID_CLASS}">${compactOptions}</div>
  </section>
  <div data-share-actions class="${SHARE_CONFIRM_ACTIONS_CLASSNAME}">
    <button data-share-cta class="${SHARE_CONFIRM_PRIMARY_CTA_CLASSNAME} inline-flex items-center justify-center">Start sharing</button>
  </div>
  <div class="mx-auto w-full max-w-[560px]">${headers}</div>
</main></body></html>`,
  );
  return `file://${path.join(dir, "fixture.html")}`;
}

test.describe("One Location compact CTA layout", () => {
  for (const width of WIDTHS) {
    test(`balances link, share and header controls at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 1200 });
      await page.goto(await buildFixture());
      await awaitProductFont(page);

      const result = await page.evaluate(() => {
        const box = (selector: string) =>
          document.querySelector<HTMLElement>(selector)!.getBoundingClientRect();
        const publicCard = box("[data-public-card]");
        const publicControls = box("[data-public-controls]");
        const publicOptions = Array.from(
          document.querySelectorAll<HTMLElement>("[data-public-option]"),
        ).map((node) => node.getBoundingClientRect());
        const publicCta = box("[data-public-cta]");
        const shareCard = box("[data-share-card]");
        const shareOptions = box("[data-share-options]");
        const shareCells = Array.from(
          document.querySelectorAll<HTMLElement>("[data-share-option]"),
        ).map((node) => node.getBoundingClientRect());
        const shareActions = box("[data-share-actions]");
        const shareCta = box("[data-share-cta]");
        const headers = Array.from(
          document.querySelectorAll<HTMLElement>("[data-header]"),
        ).map((header) => {
          const actions = header.querySelector<HTMLElement>(
            "[data-header-actions]",
          )!;
          const status = header.querySelector<HTMLElement>(
            "[data-header-status]",
          )!;
          const toggle = header.querySelector<HTMLElement>(
            "[data-header-switch]",
          )!;
          const title = header.querySelector<HTMLElement>(
            "[data-header-title]",
          )!;
          return {
            header: header.getBoundingClientRect().toJSON(),
            actions: actions.getBoundingClientRect().toJSON(),
            toggle: toggle.getBoundingClientRect().toJSON(),
            status: status.getBoundingClientRect().toJSON(),
            statusClientWidth: status.clientWidth,
            statusScrollWidth: status.scrollWidth,
            statusClientHeight: status.clientHeight,
            statusScrollHeight: status.scrollHeight,
            titleClientWidth: title.clientWidth,
            titleScrollWidth: title.scrollWidth,
          };
        });
        return {
          publicCard: publicCard.toJSON(),
          publicControls: publicControls.toJSON(),
          publicOptions: publicOptions.map((value) => value.toJSON()),
          publicCta: publicCta.toJSON(),
          shareCard: shareCard.toJSON(),
          shareOptions: shareOptions.toJSON(),
          shareCells: shareCells.map((value) => value.toJSON()),
          shareActions: shareActions.toJSON(),
          shareCta: shareCta.toJSON(),
          headers,
          overflow:
            document.documentElement.scrollWidth -
            document.documentElement.clientWidth,
        };
      });

      expect(result.overflow).toBeLessThanOrEqual(1);

      expect(result.publicControls.width).toBeLessThanOrEqual(280.5);
      expect(
        Math.abs(
          result.publicControls.left -
            (result.publicCard.left +
              (result.publicCard.width - result.publicControls.width) / 2),
        ),
      ).toBeLessThanOrEqual(1);
      expect(
        Math.abs(
          result.publicOptions[0].width - result.publicOptions[1].width,
        ),
      ).toBeLessThanOrEqual(1);
      expect(result.publicOptions[0].height).toBeGreaterThanOrEqual(44);
      expect(result.publicOptions[1].height).toBeGreaterThanOrEqual(44);
      expect(
        Math.abs(result.publicCta.width - result.publicControls.width),
      ).toBeLessThanOrEqual(1);

      expect(result.shareOptions.width).toBeLessThanOrEqual(240.5);
      expect(
        Math.abs(
          result.shareOptions.left -
            (result.shareCard.left +
              (result.shareCard.width - result.shareOptions.width) / 2),
        ),
      ).toBeLessThanOrEqual(1);
      expect(new Set(result.shareCells.map((cell) => Math.round(cell.top))).size).toBe(2);
      for (const cell of result.shareCells) {
        expect(cell.height).toBeGreaterThanOrEqual(44);
        expect(
          Math.abs(cell.width - result.shareCells[0].width),
        ).toBeLessThanOrEqual(1);
      }

      expect(result.shareActions.width).toBeLessThanOrEqual(320.5);
      expect(result.shareCta.width).toBeCloseTo(result.shareActions.width, 0);
      if (width >= 430) {
        expect(result.shareCta.width).toBeLessThan(result.shareCard.width - 30);
      }

      for (const header of result.headers) {
        expect(header.actions.right).toBeLessThanOrEqual(header.header.right + 1);
        expect(header.toggle.left).toBeGreaterThanOrEqual(
          header.actions.left - 1,
        );
        expect(header.toggle.right).toBeLessThanOrEqual(
          header.actions.right + 1,
        );
        expect(header.statusScrollWidth).toBeLessThanOrEqual(
          header.statusClientWidth + 1,
        );
        expect(header.statusScrollHeight).toBeLessThanOrEqual(
          header.statusClientHeight + 1,
        );
        expect(header.titleScrollWidth).toBeLessThanOrEqual(
          header.titleClientWidth + 1,
        );
      }
    });
  }
});
