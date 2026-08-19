import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  awaitProductFont,
  productFontStyle,
  stripAppFontFaces,
} from "./fixtures/product-font";

// Relative, not "@/": the e2e tsconfig deliberately carries no path aliases.
import {
  CREATE_CIRCLE_CTA_CLASSNAME,
  CREATE_CIRCLE_CTA_MIN_HEIGHT_PX,
  CREATE_CIRCLE_NAME_INPUT_CLASSNAME,
  CREATE_CIRCLE_NAME_INPUT_HEIGHT_PX,
  CREATE_CIRCLE_NAME_PLACEHOLDER,
} from "../components/one-location/redesign/circles/create-circle-layout";
import { BLOCKED_CTA } from "../components/one-location/redesign/circles/blocked-cta";
import { buttonVariants } from "../components/ui/button";
import { cn } from "../lib/utils";

/**
 * Create a circle, measured in a real engine at the widths the app ships on.
 *
 * The screen grew a lock state: Circles are reachable by an account that holds
 * no lock, so the primary action now spends time in a loading state while that
 * state settles, and opens an unlock sheet instead of dead-ending on a toast.
 * A loading button that changes size, or a label that clips once a spinner is
 * overlaid on it, would be a new defect introduced by that fix — and JSDOM
 * cannot see either, because it applies no CSS and measures every box as 0x0.
 * The sibling JSDOM suite proves the behaviour; this file proves the pixels.
 *
 * The route is behind sign-in, so this renders the real class strings imported
 * from the module the screen itself imports — the same approach the ready-panel,
 * save-location-sheet and connect-circle-cta contracts already take.
 *
 * Run with: npm run test:layout-contracts
 */

/** iPhone SE through Pro Max, plus one tablet reference. `sm:` is 640px, so
 *  every phone width the App Store build serves is below it. */
const PHONE_WIDTHS = [320, 375, 390, 430] as const;
const WIDTHS = [...PHONE_WIDTHS, 768] as const;

/** The app's horizontal page padding at phone widths, as a conservative floor. */
const PAGE_PADDING_PX = 16;

/** Apple's minimum comfortable touch target. */
const MIN_TOUCH_TARGET_PX = 44;

async function buildStylesheet(candidates: string[]): Promise<string> {
  const webappRoot = process.cwd();
  const { compile } = (await import(
    path.join(webappRoot, "node_modules/tailwindcss/dist/lib.mjs")
  )) as {
    compile: (
      css: string,
      opts: unknown,
    ) => Promise<{ build: (c: string[]) => string }>;
  };

  // `globals.css`, not a bare `@import "tailwindcss"`: the product type scale
  // lives there, and compiling without it would measure a 16px system font.
  // `@source` is stripped — it widens the scanner for the real build, and here
  // the candidate list is explicit.
  const globals = fs
    .readFileSync(path.join(webappRoot, "app/globals.css"), "utf8")
    .replace(/^@source\s+[^;]+;\s*$/gm, "");

  const compiler = await compile(globals, {
    base: path.join(webappRoot, "app"),
    onDependency: () => {},
    loadStylesheet: async (id: string, base: string) => {
      const file =
        id === "tailwindcss"
          ? path.join(webappRoot, "node_modules/tailwindcss/index.css")
          : id === "tw-animate-css"
            ? path.join(
                webappRoot,
                "node_modules/tw-animate-css/dist/tw-animate.css",
              )
            : path.resolve(base, id);
      return {
        path: file,
        base: path.dirname(file),
        content: fs.readFileSync(file, "utf8"),
      };
    },
  });

  // The app's own @font-face rules cannot load over file:// and, sharing a
  // family name with the working one, stop it satisfying fonts.check.
  return stripAppFontFaces(compiler.build(candidates));
}

async function buildFixture(name: string, body: string, candidates: string[]) {
  const webappRoot = process.cwd();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));

  let css = await buildStylesheet(candidates);

  // Without the real Inter face every width below measures the wrong typeface,
  // which is the only thing the label assertions are actually about.
  const fontSource = path.join(webappRoot, "public/fonts/Inter");
  if (fs.existsSync(fontSource)) {
    fs.cpSync(fontSource, path.join(dir, "fonts/Inter"), { recursive: true });
    css = css.replace(/url\(["']?\/fonts\//g, 'url("./fonts/');
  }

  fs.writeFileSync(path.join(dir, "fixture.css"), css);
  fs.writeFileSync(
    path.join(dir, "fixture.html"),
    `<!doctype html><html><head><meta charset="utf-8">
<style>${productFontStyle()}</style>
<link rel="stylesheet" href="fixture.css"></head>
<body style="margin:0"><div style="padding:0 ${PAGE_PADDING_PX}px">${body}</div></body></html>`,
  );
  return `file://${path.join(dir, "fixture.html")}`;
}

interface Box {
  top: number;
  bottom: number;
  left: number;
  right: number;
  width: number;
  height: number;
}

/** The selector is passed as an argument, never captured: `page.evaluate` ships
 *  the function's source to the browser, where a closure variable from this
 *  file would arrive undefined. */
function boxOf(page: Page, selector: string): Promise<Box> {
  return page.evaluate((sel) => {
    const node = document.querySelector(sel);
    if (!node) throw new Error(`missing ${sel}`);
    const r = node.getBoundingClientRect();
    return {
      top: r.top,
      bottom: r.bottom,
      left: r.left,
      right: r.right,
      width: r.width,
      height: r.height,
    };
  }, selector);
}

/** True when a node's text is wider than the box drawing it — the measurement
 *  that catches an ellipsis, which a class-name assertion cannot. */
function isClipped(page: Page, selector: string): Promise<boolean> {
  return page.evaluate((sel) => {
    const node = document.querySelector(sel) as HTMLElement | null;
    if (!node) throw new Error(`missing ${sel}`);
    return node.scrollWidth > node.clientWidth + 1;
  }, selector);
}

const CTA_CLASS = cn(
  buttonVariants({ variant: "default", size: "default" }),
  CREATE_CIRCLE_CTA_CLASSNAME,
  BLOCKED_CTA,
);

/**
 * The CTA in each of the three states the lock decision can put it in.
 *
 * `idle` — a lock is open, the name is typed, the action is live.
 * `resolving` — identity is still settling. The screen waits rather than
 *   calling an unsettled state "locked", so the button is busy, not dead.
 *   Its markup mirrors `components/ui/button.tsx`: the label stays in flow at
 *   `opacity-0` to hold the width, with the spinner absolutely centered over it.
 * `blocked` — nothing typed yet. `BLOCKED_CTA` paints a neutral fill rather
 *   than a half-opacity accent that still reads as tappable.
 */
const CTA_BODY = `
<div style="display:flex;flex-direction:column;gap:24px">
  <input id="name" class="${CREATE_CIRCLE_NAME_INPUT_CLASSNAME}" placeholder="${CREATE_CIRCLE_NAME_PLACEHOLDER}" />
  <button id="cta-idle" class="${CTA_CLASS}"><span id="cta-idle-label">Create circle</span></button>
  <button id="cta-resolving" class="${CTA_CLASS}" disabled aria-busy="true"><span class="relative inline-flex items-center justify-center"><span id="cta-resolving-label" class="opacity-0">Create circle</span><span class="absolute inset-0 flex items-center justify-center"><svg class="h-4 w-4 animate-spin" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2"/></svg></span></span></button>
  <button id="cta-blocked" class="${CTA_CLASS}" disabled><span id="cta-blocked-label">Create circle</span></button>
</div>`;

/** One candidate per class token. The compiler takes a list of candidates, not
 *  a blob of markup — passing a single joined string yields no utilities and
 *  every box measures as unstyled text. */
const CTA_CANDIDATES = [
  ...CTA_CLASS.split(/\s+/),
  ...CREATE_CIRCLE_NAME_INPUT_CLASSNAME.split(/\s+/),
  ...(
    "relative inline-flex items-center justify-center opacity-0 absolute " +
    "inset-0 flex h-4 w-4 animate-spin flex-col gap-6"
  ).split(/\s+/),
];

test.describe("Create a circle — primary action across phone widths", () => {
  for (const width of WIDTHS) {
    test(`holds its height, width and label at ${width}px`, async ({ page }) => {
      const url = await buildFixture("create-circle-cta", CTA_BODY, CTA_CANDIDATES);
      await page.setViewportSize({ width, height: 900 });
      await page.goto(url);
      await awaitProductFont(page);

      const available = width - PAGE_PADDING_PX * 2;
      const idle = await boxOf(page, "#cta-idle");
      const resolving = await boxOf(page, "#cta-resolving");
      const blocked = await boxOf(page, "#cta-blocked");
      const nameField = await boxOf(page, "#name");

      // Every state is a full-width primary action, and none of them overflows
      // the page. A CTA wider than the page is a horizontal scrollbar.
      for (const [label, box] of [
        ["idle", idle],
        ["resolving", resolving],
        ["blocked", blocked],
      ] as const) {
        expect(
          Math.round(box.width),
          `${label} CTA width at ${width}px`,
        ).toBe(available);
        expect(
          box.height,
          `${label} CTA height at ${width}px`,
        ).toBeGreaterThanOrEqual(CREATE_CIRCLE_CTA_MIN_HEIGHT_PX);
        expect(
          box.height,
          `${label} CTA touch target at ${width}px`,
        ).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
      }

      // The lock state must not resize the button. A CTA that shrinks the
      // moment it goes busy makes the screen twitch under the thumb, and it is
      // exactly what an inline spinner beside the label would have caused.
      expect(
        Math.round(resolving.height),
        `busy CTA must not change height at ${width}px`,
      ).toBe(Math.round(idle.height));
      expect(
        Math.round(resolving.width),
        `busy CTA must not change width at ${width}px`,
      ).toBe(Math.round(idle.width));

      // The label survives in every state, including under the spinner — it is
      // held in flow at opacity 0 precisely so the width cannot collapse.
      for (const id of ["cta-idle-label", "cta-resolving-label", "cta-blocked-label"]) {
        expect(
          await isClipped(page, `#${id}`),
          `${id} must not clip at ${width}px`,
        ).toBe(false);
      }

      // The name field is the first thing the person touches. It stays a
      // comfortable target and never overflows the page either.
      expect(
        Math.round(nameField.width),
        `name field width at ${width}px`,
      ).toBe(available);
      expect(
        nameField.height,
        `name field height at ${width}px`,
      ).toBeGreaterThanOrEqual(CREATE_CIRCLE_NAME_INPUT_HEIGHT_PX);

      // Nothing on the screen pushes the page sideways.
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth,
      );
      expect(overflow, `no horizontal overflow at ${width}px`).toBeLessThanOrEqual(
        width,
      );
    });
  }

  test("the blocked fill is opaque, not a dimmed accent", async ({ page }) => {
    // A disabled morphy Button otherwise renders full Action Blue at 50%
    // opacity, which still reads as tappable. `BLOCKED_CTA` exists to stop
    // that, and the only way to know it won the cascade is to read the pixel.
    const url = await buildFixture("create-circle-cta-blocked", CTA_BODY, CTA_CANDIDATES);
    await page.setViewportSize({ width: 390, height: 900 });
    await page.goto(url);
    await awaitProductFont(page);

    const computed = await page.evaluate(() => {
      const node = document.querySelector("#cta-blocked") as HTMLElement;
      const style = getComputedStyle(node);
      return { opacity: style.opacity, background: style.backgroundColor };
    });

    expect(Number(computed.opacity)).toBe(1);
    // Read through a canvas rather than string-matching the value: Tailwind's
    // opacity utilities resolve to oklab, so a regex written for `rgba(...)`
    // silently passes the very value it was meant to reject.
    const alpha = await page.evaluate((color) => {
      const canvas = document.createElement("canvas");
      canvas.width = 1;
      canvas.height = 1;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("no 2d context");
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, 1, 1);
      return ctx.getImageData(0, 0, 1, 1).data[3];
    }, computed.background);
    // A translucent neutral over the sheet, never a solid accent.
    expect(alpha).toBeLessThan(255);
  });
});
