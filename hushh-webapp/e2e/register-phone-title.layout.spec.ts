import { expect, test } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { awaitProductFont, productFontStyle, stripAppFontFaces } from "./fixtures/product-font";

/**
 * "Verify your phone number" ("/register-phone", app/register-phone/page.tsx)
 * used to wrap onto a second line ("Verify your phone" / "number") on
 * anything wider than a narrow phone.
 *
 * The root cause: the foundation h1 rule (app/globals.css) sizes every
 * heading with `clamp(1.75rem, 1.46rem + 1.2vw, 2.5rem)` — it keeps growing
 * with raw VIEWPORT width. This title sits in a card capped at
 * `max-w-[440px]`, so past 440px wide the text column stops growing while the
 * font kept climbing toward its 40px ceiling. jsdom has no layout engine and
 * cannot reproduce a wrap; only a real browser measuring the real compiled
 * CSS and the real product font can.
 *
 * The fix is `h1.phone-mandate-title` in globals.css: a scoped override whose
 * own ceiling (28px) is reached by 440px viewport width — the same point the
 * card itself stops growing — so neither can outrun the other.
 *
 * Run with: npm run test:layout-contracts
 */

/** Phones (the auth-sign-in convention) plus wide viewports where the base h1
 * rule keeps scaling — this is exactly the range that reproduced the bug. */
const WIDTHS = [320, 344, 375, 390, 414, 430, 440, 600, 768, 1024, 1440] as const;
const HEIGHT = 844;

/** Sub-pixel line boxes only. A real regression lands tens of px over. */
const SLACK_PX = 1;

const webappRoot = process.cwd();

function readSource(repoPath: string): string {
  return fs.readFileSync(path.join(webappRoot, repoPath), "utf8");
}

/** Pull the first capture of `pattern`, or explain what to fix. */
function capture(source: string, pattern: RegExp, what: string): string {
  const found = source.match(pattern)?.[1];
  if (!found) {
    throw new Error(
      `register-phone-title.layout: ${what} no longer matches ` +
        `app/register-phone/page.tsx. Update this spec so it keeps measuring ` +
        `the real screen instead of an empty box.`,
    );
  }
  return found;
}

type Pieces = {
  contentClass: string;
  wrapClass: string;
  titleClass: string;
};

function readPieces(): Pieces {
  const source = readSource("app/register-phone/page.tsx");

  return {
    contentClass: capture(
      source,
      /className="(relative mx-auto flex w-full max-w-\[440px\] flex-col)"/,
      "the max-w-[440px] centered content column",
    ),
    wrapClass: capture(
      source,
      /className="(px-6 pb-3 pt-7 text-center)"/,
      "the title's padded wrapper",
    ),
    titleClass: capture(
      source,
      /aria-label="Verify your phone number"\s*\n\s*className="([^"]*)"/,
      "the h1's className (it must still carry phone-mandate-title)",
    ),
  };
}

async function buildStylesheet(candidates: string[]): Promise<string> {
  const { compile } = (await import(
    path.join(webappRoot, "node_modules/tailwindcss/dist/lib.mjs")
  )) as {
    compile: (
      css: string,
      opts: unknown,
    ) => Promise<{ build: (c: string[]) => string }>;
  };

  const globals = readSource("app/globals.css").replace(
    /^@source\s+[^;]+;\s*$/gm,
    "",
  );

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

  return stripAppFontFaces(compiler.build(candidates));
}

async function writeFixture(): Promise<string> {
  const p = readPieces();

  // phone-mandate-title is a plain CSS rule inside `@layer base`, not a
  // Tailwind utility — it renders regardless of the candidate list. Only the
  // real utility classes need to be named here for Tailwind's JIT engine to
  // generate them.
  const candidates = [p.contentClass, p.wrapClass, p.titleClass]
    .join(" ")
    .split(/\s+/)
    .filter(Boolean)
    .filter((c) => c !== "phone-mandate-title");

  const css = await buildStylesheet(candidates);
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "register-phone-title-layout-"),
  );
  fs.writeFileSync(path.join(dir, "fixture.css"), css);
  fs.writeFileSync(
    path.join(dir, "fixture.html"),
    `<!doctype html><html><head><meta charset="utf-8">
<style>${productFontStyle()}</style>
<link rel="stylesheet" href="fixture.css">
<style>body { margin: 0; }</style></head>
<body>
  <main class="w-full">
    <div class="${p.contentClass}">
      <div class="${p.wrapClass}">
        <h1
          role="heading"
          aria-level="1"
          aria-label="Verify your phone number"
          class="${p.titleClass}"
          data-register-phone-title
        >Verify your phone number</h1>
      </div>
    </div>
  </main>
</body></html>`,
  );
  return `file://${path.join(dir, "fixture.html")}`;
}

test.describe("register-phone title layout", () => {
  for (const width of WIDTHS) {
    test(`"Verify your phone number" stays on one line at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: HEIGHT });
      await page.goto(await writeFixture());
      await awaitProductFont(page);

      const measured = await page.evaluate(() => {
        const title = document.querySelector<HTMLElement>(
          "[data-register-phone-title]",
        )!;
        const textNode = title.firstChild!;
        const range = document.createRange();
        range.selectNodeContents(textNode);

        return {
          text: title.textContent,
          lineCount: range.getClientRects().length,
          titleWidth: +title.getBoundingClientRect().width.toFixed(2),
          horizontalOverflow:
            document.documentElement.scrollWidth -
            document.documentElement.clientWidth,
          fontSize: Number.parseFloat(getComputedStyle(title).fontSize),
        };
      });

      expect(
        measured.text,
        "fixture rendered nothing — the class extraction is measuring an empty box",
      ).toBe("Verify your phone number");

      expect(
        measured.lineCount,
        `"Verify your phone number" wraps onto ${measured.lineCount} lines ` +
          `at ${width}px (font-size resolved to ${measured.fontSize}px, ` +
          `rendered ${measured.titleWidth}px wide)`,
      ).toBe(1);

      expect(
        measured.horizontalOverflow,
        `the title forces ${measured.horizontalOverflow}px of horizontal scroll at ${width}px`,
      ).toBeLessThanOrEqual(SLACK_PX);
    });
  }
});
