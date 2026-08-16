import { expect, test } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The "Requests sent" row, measured in a real browser at phone widths.
 *
 * A pending row used to end in the bare word "Pending": the state was named
 * and there was nothing to do about it. It now ends in a "Take back" button.
 * `SettingsRow` gives its trailing slot `shrink-0`, so whatever goes there is
 * paid for by the person's name, which wraps instead.
 *
 * That is not hypothetical. The first version of this row kept the word AND
 * added the button: 161px of trailing content against the 115px the shipped
 * Edit/Stop pair uses in the identical slot, which wrapped "Abdul Rashid" onto
 * a second line at 320px and grew the row from 70px to 166px. JSDOM performs
 * no layout and could not see any of it. This file is why the word was
 * dropped, and what stops it coming back.
 *
 * The markup is the real rendered output of `SettingsGroup` + `SettingsRow` +
 * `Button`, captured from those components rather than hand-written, so the
 * classes under test are the ones that ship. It holds two rows: the pending
 * one, and the live Edit/Stop row that is its reference. The hub itself is
 * behind sign-in, which is why the row is measured here rather than driven
 * through the route.
 *
 * Run with: npx playwright test e2e/one-location-requests-sent-row.layout.spec.ts
 */

const WIDTHS = [320, 360, 375, 390, 430] as const;

/** A name on one line. Two lines means the trailing slot ate the row. */
const SINGLE_LINE_MAX_PX = 30;

const ROW_MARKUP_PATH = path.join(
  process.cwd(),
  "e2e/fixtures/one-location-requests-sent-row.html",
);

/** Compile just the utilities this fixture uses, with the real Tailwind. */
async function buildFixture(): Promise<string> {
  const webappRoot = process.cwd();
  const { compile } = (await import(
    path.join(webappRoot, "node_modules/tailwindcss/dist/lib.mjs")
  )) as {
    compile: (css: string, opts: unknown) => Promise<{ build: (c: string[]) => string }>;
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
  const css = compiler.build([...used]);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "requests-sent-row-"));
  fs.writeFileSync(path.join(dir, "fixture.css"), css);
  fs.writeFileSync(
    path.join(dir, "fixture.html"),
    `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="fixture.css">
<style>
  /* The app shell's own tokens, which this fixture has no shell to inherit. */
  :root {
    --settings-row-gap: 12px; --settings-row-px: 16px; --settings-row-py: 12px;
    --settings-heading-stack-gap: 4px;
    --app-card-radius-standard: 24px;
    --app-primary-surface: #fff; --app-separator: #e5e5ea;
    --app-secondary-label: #8e8e93; --app-neutral-fill: #f2f2f7;
    --app-card-shadow-standard: 0 1px 2px rgba(0,0,0,.06);
  }
  body { margin: 0; font-family: -apple-system, system-ui, sans-serif; }
</style></head><body><div style="padding:0 8px">${markup}</div></body></html>`,
  );
  return `file://${path.join(dir, "fixture.html")}`;
}

type RowProbe = {
  titleWidth: number;
  titleHeight: number;
  titleText: string;
  trailingWidth: number;
  trailingText: string;
  trailingRight: number;
  trailingHeight: number;
};

test.describe("Requests sent row", () => {
  for (const width of WIDTHS) {
    test(`keeps the name on one line at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(await buildFixture());

      const measured = await page.evaluate(() => {
        const root = document.documentElement;
        const rows = [...document.querySelectorAll('[data-testid="settings-row"]')];
        const probe = (row: Element): RowProbe => {
          const title = row.querySelector('[data-slot="settings-row-title"]');
          const inner = row.firstElementChild as HTMLElement | null;
          const kids = inner ? [...inner.children] : [];
          const trailing = kids[kids.length - 1];
          const titleBox = title?.getBoundingClientRect();
          const trailingBox = trailing?.getBoundingClientRect();
          return {
            titleWidth: titleBox?.width ?? 0,
            titleHeight: titleBox?.height ?? 0,
            titleText: title?.textContent ?? "",
            trailingWidth: trailingBox?.width ?? 0,
            trailingText: trailing?.textContent ?? "",
            trailingRight: trailingBox?.right ?? 0,
            trailingHeight: trailingBox?.height ?? 0,
          };
        };
        return {
          overflow:
            Math.max(root.scrollWidth, document.body.scrollWidth) - root.clientWidth,
          rows: rows.map(probe),
        };
      });

      const [pending, liveReference] = measured.rows as RowProbe[];

      // The fixture has to be the two rows this contract is about.
      expect(pending?.trailingText).toBe("Take back");
      expect(liveReference?.trailingText).toBe("EditStop");

      // Nothing may push the page sideways at any phone width.
      expect(measured.overflow).toBeLessThanOrEqual(1);
      expect(pending.trailingRight).toBeLessThanOrEqual(width + 1);

      // The regression this file was written for: the name wrapping because
      // the trailing slot took the row.
      expect(pending.titleHeight).toBeLessThanOrEqual(SINGLE_LINE_MAX_PX);

      // The bound that keeps it that way. A pending row must not cost more
      // than the two-button live row already shipping in the same slot --
      // "Pending" plus the button was 161px against its 115px.
      expect(pending.trailingWidth).toBeLessThanOrEqual(
        liveReference.trailingWidth,
      );

      // And the name gets the room that buys: more than the live row's, since
      // one button costs less than two.
      expect(pending.titleWidth).toBeGreaterThan(liveReference.titleWidth);

      // The control still has to be reachable with a thumb.
      expect(pending.trailingHeight).toBeGreaterThanOrEqual(36);
    });
  }
});
