import { expect, test } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The Feed's sticky section header ("Live" / "Needs you" / a day divider),
 * measured in a real browser.
 *
 * Reported bug: while scrolling, the row that had been sitting above a
 * section (e.g. an earlier "Emergency SMS - Sent" row) stayed faintly
 * visible behind the "Live" / "Needs you" label as it scrolled underneath.
 * Root cause: `SectionLabel` in feed-page.tsx painted its sticky background
 * as `bg-background/85 backdrop-blur-md` -- 85% opaque, not 100% -- so the
 * row scrolling beneath it always showed through by design. Every OTHER
 * sticky header in this app (data-table.tsx, settings-ui.tsx,
 * ria/picks/page.tsx) uses a fully opaque, theme-aware solid token instead;
 * the Feed header was the one outlier.
 *
 * A JSDOM test can prove the class string changed; it cannot prove a pixel
 * is actually opaque, because JSDOM performs no compositing. This measures
 * the computed background through a canvas rather than pattern-matching the
 * computed string -- Tailwind resolves `bg-…/85` to `color-mix(in oklab, …)`,
 * not to an `rgba(…)`, so a regex looking for `rgba` would pass the very
 * translucent value it was written to reject.
 *
 * Run with: npm run test:layout-contracts
 */

/** Compile just the utilities this fixture uses, with the real Tailwind. */
async function buildFixture(surfaceToken: string): Promise<string> {
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

  // The exact class string SectionLabel ships in feed-page.tsx.
  const sectionHeader =
    "sticky top-[var(--top-shell-live-height)] z-10 bg-[color:var(--app-card-surface-sticky-header-solid)] px-[6px] pb-2 pt-7 backdrop-blur";
  const peekRow = "flex h-[60px] items-center px-[6px] text-white";
  const scroller = "h-[300px] overflow-y-auto";

  const css = compiler.build(
    [sectionHeader, peekRow, scroller, "h-[60px]", "flex items-center px-[6px]"]
      .join(" ")
      .split(/\s+/)
      .filter(Boolean),
  );

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "feed-sticky-header-"));
  fs.writeFileSync(path.join(dir, "fixture.css"), css);
  fs.writeFileSync(
    path.join(dir, "fixture.html"),
    `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="fixture.css">
<style>:root{--top-shell-live-height:0px;--app-card-surface-sticky-header-solid:${surfaceToken}}</style>
</head><body style="margin:0">
<div class="${scroller}" data-testid="scroller">
  <div class="${peekRow}" style="background:#ff0000" data-testid="peek-row">Emergency SMS - Sent</div>
  <h2 class="${sectionHeader}" data-testid="section-header">Needs you</h2>
  <div class="${peekRow}" style="background:#0a7d32">Sharu Khan</div>
  <div class="${peekRow}" style="background:#0a4f7d">Divya Rajendran</div>
  <div class="${peekRow}" style="background:#7d0a5e">Another row</div>
  <div class="${peekRow}" style="background:#7d5e0a">Yet another row</div>
</div>
</body></html>`,
  );
  return `file://${path.join(dir, "fixture.html")}`;
}

const SURFACE_TOKENS = [
  { theme: "light", token: "#f6f7fb" },
  { theme: "dark", token: "#2f2f31" },
] as const;

test.describe("Feed sticky section header stays opaque while scrolling", () => {
  for (const { theme, token } of SURFACE_TOKENS) {
    test(`paints over the row scrolled beneath it (${theme})`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(await buildFixture(token));

      // Scroll the peek row up under the now-stuck header, reproducing the
      // reported scroll position.
      await page.getByTestId("scroller").evaluate((el) => {
        el.scrollTop = 60;
      });

      const alpha = await page.getByTestId("section-header").evaluate((el) => {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 1;
        const ctx = canvas.getContext("2d")!;
        ctx.clearRect(0, 0, 1, 1);
        // Seeded transparent: a colour the canvas cannot parse leaves alpha
        // at 0 and fails loudly instead of silently reading as opaque.
        ctx.fillStyle = "rgba(0, 0, 0, 0)";
        ctx.fillStyle = getComputedStyle(el).backgroundColor;
        ctx.fillRect(0, 0, 1, 1);
        return ctx.getImageData(0, 0, 1, 1).data[3];
      });
      // Anything under 255 and the row behind it shows through the header.
      expect(alpha).toBe(255);

      const position = await page
        .getByTestId("section-header")
        .evaluate((el) => getComputedStyle(el).position);
      expect(position).toBe("sticky");
    });
  }
});
