import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { buttonVariants } from "../lib/ui/button-variants";
import { cn } from "../lib/morphy-ux/cn";
import { getVariantStyles } from "../lib/morphy-ux/utils";
import {
  awaitProductFont,
  productFontStyle,
  stripAppFontFaces,
} from "./fixtures/product-font";

/** A CSS-level contract for the shipped Stock and Morphy button recipes. */
const WIDTHS = [320, 768, 1440] as const;
const THEMES = ["light", "dark"] as const;
const ACCENTS = ["blue", "gold"] as const;

function flowActionMeasureClass(): string {
  const source = fs.readFileSync(
    path.join(process.cwd(), "components/app-ui/flow-actions.tsx"),
    "utf8",
  );
  const match = source.match(
    /export const FLOW_ACTION_MEASURE_CLASSNAME\s*=\s*"([^"]+)"/,
  );
  if (!match) throw new Error("Flow action decision measure was not found");
  return match[1];
}

const DECISION_CLASS = flowActionMeasureClass();

/** Exercise Morphy's own variant styles on its shared StockButton base. */
function morphyClasses(
  variant: "blue" | "none" | "destructive",
  effect: "fill" | "fade",
): string {
  return cn(
    buttonVariants({
      variant: variant === "destructive" ? "destructive" : "ghost",
      size: "standard",
    }),
    getVariantStyles(variant, effect),
    "w-full",
  );
}

const CONTROLS = [
  {
    id: "stock-primary",
    label: "Primary action",
    className: cn(buttonVariants({ variant: "default", size: "standard" }), "w-full"),
  },
  {
    id: "stock-secondary",
    label: "Secondary action",
    className: cn(buttonVariants({ variant: "secondary", size: "standard" }), "w-full"),
  },
  {
    id: "stock-destructive",
    label: "Delete connection",
    className: cn(buttonVariants({ variant: "destructive", size: "standard" }), "w-full"),
  },
  {
    id: "stock-ghost",
    label: "More options",
    className: cn(buttonVariants({ variant: "ghost", size: "standard" }), "w-full"),
  },
  {
    id: "morphy-primary",
    label: "Connect service",
    className: morphyClasses("blue", "fill"),
  },
  {
    id: "morphy-secondary",
    label: "Review details",
    className: morphyClasses("none", "fade"),
  },
  {
    id: "morphy-destructive",
    label: "Remove access",
    className: morphyClasses("destructive", "fill"),
  },
  {
    id: "morphy-ghost",
    label: "View settings",
    className: morphyClasses("blue", "fade"),
  },
] as const;

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

async function fixtureUrl(
  theme: (typeof THEMES)[number],
  accent: (typeof ACCENTS)[number],
): Promise<string> {
  const root = process.cwd();
  const { compile } = (await import(
    pathToFileURL(path.join(root, "node_modules/tailwindcss/dist/lib.mjs")).href
  )) as {
    compile: (
      css: string,
      options: unknown,
    ) => Promise<{ build: (candidates: string[]) => string }>;
  };
  const globals = fs
    .readFileSync(path.join(root, "app/globals.css"), "utf8")
    .replace(/^@source\s+[^;]+;\s*$/gm, "");
  const compiler = await compile(globals, {
    base: path.join(root, "app"),
    onDependency: () => {},
    loadStylesheet: async (id: string, base: string) => {
      const file =
        id === "tailwindcss"
          ? path.join(root, "node_modules/tailwindcss/index.css")
          : id === "tw-animate-css"
            ? path.join(root, "node_modules/tw-animate-css/dist/tw-animate.css")
            : path.resolve(base, id);
      return {
        path: file,
        base: path.dirname(file),
        content: fs.readFileSync(file, "utf8"),
      };
    },
  });
  const candidates = new Set<string>();
  for (const className of [...CONTROLS.map((control) => control.className), DECISION_CLASS]) {
    for (const token of className.split(/\s+/)) if (token) candidates.add(token);
  }
  const css = stripAppFontFaces(compiler.build([...candidates]));
  const controls = CONTROLS.map(
    ({ id, label, className }) =>
      `<button type="button" data-control="${id}" class="${escapeAttribute(className)}">${label}</button>`,
  ).join("\n");
  const disabledClass = CONTROLS[0].className;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "muse-controls-"));
  const file = path.join(dir, "fixture.html");
  fs.writeFileSync(
    file,
    `<!doctype html><html class="${theme === "dark" ? "dark" : ""}" data-accent="${accent}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<style>${productFontStyle()}</style><style>${css}</style>
<style>
  body { margin: 0; }
  .test-page { box-sizing: border-box; width: min(100%, 760px); margin-inline: auto; padding: 16px; }
  .test-card { box-sizing: border-box; width: 100%; padding: 16px; border: 1px solid var(--app-settings-border); border-radius: 18px; background: var(--app-settings-surface); }
  .test-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 240px), 1fr)); gap: 12px; }
  .test-decision { margin-top: 24px; }
</style></head><body>
<main class="test-page" data-one-workspace="settings">
  <section class="test-card" aria-label="Control system">
    <div class="test-grid">${controls}
      <button type="button" data-control="stock-primary-disabled" class="${escapeAttribute(disabledClass)}" disabled>Primary action</button>
    </div>
    <div data-testid="decision-measure" class="${escapeAttribute(DECISION_CLASS)} test-decision">
      <button type="button" class="${escapeAttribute(CONTROLS[0].className)}">Continue</button>
    </div>
  </section>
</main></body></html>`,
  );
  return pathToFileURL(file).href;
}

type ControlState = {
  contrast: number;
  height: number;
  width: number;
  left: number;
  right: number;
  fontFamily: string;
  focusVisible: boolean;
  boxShadow: string;
};

async function measureControl(page: Page, id: string): Promise<ControlState> {
  return page.locator(`[data-control="${id}"]`).evaluate((button) => {
    const card = button.closest<HTMLElement>(".test-card")!;
    const buttonStyle = getComputedStyle(button);
    const cardStyle = getComputedStyle(card);
    const colorPixel = (cssColor: string): number[] => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      const context = canvas.getContext("2d")!;
      context.fillStyle = cssColor;
      context.fillRect(0, 0, 1, 1);
      return [...context.getImageData(0, 0, 1, 1).data];
    };
    const over = (top: number[], bottom: number[]): number[] => {
      const alpha = top[3] / 255;
      return [0, 1, 2].map((index) => top[index] * alpha + bottom[index] * (1 - alpha));
    };
    const luminance = (rgb: number[]): number => {
      const linear = rgb.map((channel) => {
        const value = channel / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      });
      return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
    };
    const surface = colorPixel(cardStyle.backgroundColor);
    const background = over(colorPixel(buttonStyle.backgroundColor), surface);
    const foreground = over(colorPixel(buttonStyle.color), background);
    const [lighter, darker] = [luminance(foreground), luminance(background)].sort(
      (left, right) => right - left,
    );
    const bounds = button.getBoundingClientRect();
    return {
      contrast: (lighter + 0.05) / (darker + 0.05),
      height: bounds.height,
      width: bounds.width,
      left: bounds.left,
      right: bounds.right,
      fontFamily: buttonStyle.fontFamily,
      focusVisible: button.matches(":focus-visible"),
      boxShadow: buttonStyle.boxShadow,
    };
  });
}

for (const theme of THEMES) {
  for (const accent of ACCENTS) {
    for (const width of WIDTHS) {
      test(`${theme} ${accent} controls remain usable at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await page.emulateMedia({ reducedMotion: "reduce" });
        await page.goto(await fixtureUrl(theme, accent));
        await awaitProductFont(page);

        const measure = await page.locator("[data-testid='decision-measure']").evaluate((node) => {
          const card = node.closest<HTMLElement>(".test-card")!;
          const cardStyle = getComputedStyle(card);
          return {
            width: node.getBoundingClientRect().width,
            contentWidth:
              card.clientWidth -
              Number.parseFloat(cardStyle.paddingLeft) -
              Number.parseFloat(cardStyle.paddingRight),
            pageWidth: document.documentElement.scrollWidth,
          };
        });
        expect(measure.pageWidth).toBeLessThanOrEqual(width + 1);
        expect(measure.width).toBeLessThanOrEqual(480.5);
        expect(measure.width).toBeCloseTo(Math.min(480, measure.contentWidth), 0);

        for (const control of CONTROLS) {
          const atRest = await measureControl(page, control.id);
          expect(atRest.fontFamily, control.id).toContain("DMSansVariable");
          expect(atRest.height, control.id).toBeGreaterThanOrEqual(43.95);
          expect(atRest.width, control.id).toBeGreaterThanOrEqual(43.95);
          expect(atRest.left, control.id).toBeGreaterThanOrEqual(-0.5);
          expect(atRest.right, control.id).toBeLessThanOrEqual(width + 0.5);
          expect(atRest.contrast, `${control.id} at rest`).toBeGreaterThanOrEqual(4.5);

          await page.locator(`[data-control="${control.id}"]`).hover();
          // Both button systems specify a 100ms color transition. Read its
          // completed state, not the first interpolated frame after hover.
          await page.waitForTimeout(140);
          const hovered = await measureControl(page, control.id);
          expect(hovered.contrast, `${control.id} hovered`).toBeGreaterThanOrEqual(4.5);
        }

        // The shared StockButton foundation supplies the keyboard ring for
        // both systems; check each source's primary and ghost treatment.
        await page.keyboard.press("Tab");
        for (const id of ["stock-primary", "stock-ghost", "morphy-primary", "morphy-ghost"]) {
          await page.locator(`[data-control="${id}"]`).focus();
          const focused = await measureControl(page, id);
          expect(focused.focusVisible, id).toBe(true);
          expect(focused.boxShadow, id).not.toBe("none");
        }

        // This is only the CSS geometry of a disabled stock button. Loading
        // behavior belongs to the actual React Button interaction tests.
        const enabled = await measureControl(page, "stock-primary");
        const disabled = await measureControl(page, "stock-primary-disabled");
        expect(disabled.height).toBeCloseTo(enabled.height, 0);
        expect(disabled.width).toBeCloseTo(enabled.width, 0);

        if (process.env.MUSE_CONTROL_EVIDENCE_DIR && (width === 320 || width === 1440)) {
          fs.mkdirSync(process.env.MUSE_CONTROL_EVIDENCE_DIR, { recursive: true });
          await page.screenshot({
            path: path.join(process.env.MUSE_CONTROL_EVIDENCE_DIR, `${theme}-${accent}-${width}.png`),
          });
        }
      });
    }
  }
}
