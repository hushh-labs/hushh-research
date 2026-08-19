import { expect, test } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  awaitProductFont,
  productFontStyle,
  stripAppFontFaces,
} from "./fixtures/product-font";

/**
 * The location-request approval card's new duration-override picker
 * (RequestCard, "Share for [duration] ▾" above Approve/Decline), measured in
 * a real browser at phone widths.
 *
 * A morphy Button's `size` variant carries a `min-h-*` that tailwind-merge
 * keeps even next to an explicit `h-*` override (see cards.tsx's existing
 * Approve/Decline buttons: `h-11` + `min-h-[50px]` renders at 50px, not 44 —
 * pre-existing, not something this fix changes). jsdom cannot prove any of
 * this; only a real layout engine can. Assert real pixels, not class names.
 *
 * Run with: npx playwright test e2e/request-card-duration-picker.layout.spec.ts
 */

const WIDTHS = [320, 375, 390, 430] as const;

const ROW_MARKUP_PATH = path.join(
  process.cwd(),
  "e2e/fixtures/request-card-duration-rows.html",
);

async function buildFixture(): Promise<string> {
  const webappRoot = process.cwd();
  const { compile } = (await import(
    path.join(webappRoot, "node_modules/tailwindcss/dist/lib.mjs")
  )) as {
    compile: (
      css: string,
      opts: unknown,
    ) => Promise<{ build: (c: string[]) => string }>;
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

  const markup = fs.readFileSync(ROW_MARKUP_PATH, "utf8");
  const used = new Set<string>();
  for (const match of markup.matchAll(/class="([^"]*)"/g)) {
    for (const token of match[1].split(/\s+/)) if (token) used.add(token);
  }
  const css = stripAppFontFaces(compiler.build([...used]));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "request-card-duration-"));
  fs.writeFileSync(path.join(dir, "fixture.css"), css);
  fs.writeFileSync(
    path.join(dir, "fixture.html"),
    `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="fixture.css">
<style>
  :root {
    --app-card-radius-standard: 24px; --app-card-shadow-standard: none;
    --app-card-surface-default-solid: #1c1c1e; --app-card-surface-compact: #2c2c2e;
    --app-icon-tile-background: #2c2c2e; --app-icon-tile-foreground: #f5f5f7;
    --app-accent: #0a84ff; --app-accent-fg: #ffffff;
    --app-neutral-fill-strong: rgba(120,120,128,0.24);
    --app-focus-ring: #0a84ff; --app-success: #30d158;
  }
  body { margin: 16px; background: #000; }
${productFontStyle()}
</style></head><body>
<div style="margin:0 auto;max-width:400px">${markup}</div>
</body></html>`,
  );
  return `file://${path.join(dir, "fixture.html")}`;
}

type Probe = {
  id: string;
  cardWidth: number;
  overflowsRow: boolean;
  triggerHeight: number;
  approveHeight: number;
  declineHeight: number;
  gapAboveButtons: number;
  reasonOverflowsRow: boolean;
};

test.describe("RequestCard duration-override picker", () => {
  for (const width of WIDTHS) {
    test(`fits without overflow and keeps real touch targets at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(await buildFixture());
      await awaitProductFont(page);

      const rows = await page.evaluate(() => {
        const out: Probe[] = [];
        for (const wrapper of document.querySelectorAll<HTMLElement>(
          "body > div > div",
        )) {
          const card = wrapper.firstElementChild as HTMLElement | null;
          if (!card) continue;
          const trigger = card.querySelector<HTMLElement>(
            '[data-slot="select-trigger"]',
          );
          const buttons = card.querySelectorAll<HTMLElement>(
            "div.mt-3\\.5.flex.gap-2\\.5 > button",
          );
          const approve = buttons[0] ?? null;
          const decline = buttons[1] ?? null;
          const reason = card.querySelector<HTMLElement>(
            "p.ui-text-row-description",
          );

          const cardRect = card.getBoundingClientRect();
          const triggerRect = trigger?.getBoundingClientRect();
          const buttonsRow = approve?.parentElement?.getBoundingClientRect();

          out.push({
            id: wrapper.id,
            cardWidth: cardRect.width,
            // Nothing inside the card may run wider than the card itself —
            // the exact "content clipping / horizontal scroll" failure mode
            // named across this app's own layout contracts.
            overflowsRow: Array.from(card.querySelectorAll<HTMLElement>("*")).some(
              (el) => el.getBoundingClientRect().right > cardRect.right + 0.5,
            ),
            triggerHeight: triggerRect?.height ?? 0,
            approveHeight: approve?.getBoundingClientRect().height ?? 0,
            declineHeight: decline?.getBoundingClientRect().height ?? 0,
            gapAboveButtons:
              triggerRect && buttonsRow
                ? buttonsRow.top - triggerRect.bottom
                : 0,
            reasonOverflowsRow: reason
              ? reason.getBoundingClientRect().right > cardRect.right + 0.5
              : false,
          });
        }
        return out;
      });

      expect(rows.length, "fixture rows not found").toBe(3);

      for (const row of rows) {
        // 44px is the platform's minimum real touch target.
        expect(row.approveHeight, `${row.id}: Approve is ${row.approveHeight}px tall`).toBeGreaterThanOrEqual(44);
        expect(row.declineHeight, `${row.id}: Decline is ${row.declineHeight}px tall`).toBeGreaterThanOrEqual(44);
      }

      const withPicker = rows.filter((r) => r.id.startsWith("with-picker"));
      for (const row of withPicker) {
        // The picker is what this spec exists to prove: it must not overflow
        // the card, its reason text (the longest realistic content this card
        // renders) must not overflow, and it must be a real touch target.
        expect(row.overflowsRow, `${row.id}: content overflows the card at ${width}px`).toBe(false);
        expect(row.reasonOverflowsRow, `${row.id}: reason text overflows the card`).toBe(false);
        expect(row.triggerHeight, `${row.id}: duration picker is ${row.triggerHeight}px tall`).toBeGreaterThanOrEqual(44);
        // The picker and the Approve/Decline row must read as two distinct
        // stacked controls, not crowd into one — a real vertical gap, not a
        // hairline.
        expect(row.gapAboveButtons, `${row.id}: only ${row.gapAboveButtons.toFixed(1)}px between the picker and the buttons`).toBeGreaterThan(8);
      }

      // "no-picker-until-stopped" exercises RequestCard's pre-existing,
      // untouched single-button path (an "until I stop" ask never gets a
      // picker) — present to prove that path still renders at all, not
      // re-asserted on overflow/geometry here: that markup is unchanged by
      // this fix, and a real, narrow, pre-existing overflow on its long
      // "Approve until you stop" label at 320px is a separate, out-of-scope
      // finding (flagged separately, not fixed as part of this change).
      const noPicker = rows.find((r) => r.id === "no-picker-until-stopped");
      expect(noPicker, "no-picker-until-stopped row not found").toBeTruthy();
    });
  }
});
