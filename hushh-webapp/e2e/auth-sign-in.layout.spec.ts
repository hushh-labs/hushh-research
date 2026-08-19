import { expect, test } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  awaitProductFont,
  productFontStyle,
  stripAppFontFaces,
} from "./fixtures/product-font";

// Relative, not "@/": the e2e tsconfig deliberately carries no path aliases.
// This is the SAME merge the component runs. Without it the fixture keeps both
// the primitive's `rounded-full` and the screen's `rounded-[18px]`, stylesheet
// order picks the pill, and the spec measures a button the app never renders.
import { cn } from "../lib/morphy-ux/cn";

/**
 * The sign-in screen ("/login", components/onboarding/AuthStep.tsx) has to hold
 * three promises that only a real browser can check:
 *
 *   1. It fits one phone screen with no scrollbar, at every width we ship to.
 *      This is the one people notice. It is also the one that has broken here
 *      before: the page used a fixed `height` plus `overflow-hidden`, so when
 *      the content outgrew the box it was CUT OFF — no scrollbar, no error, the
 *      legal line simply gone. The fix was min-height, and this spec is what
 *      stops a fixed height coming back.
 *
 *   2. The two sign-in buttons are one obvious pair: same width, same height,
 *      54-56px tall so a thumb cannot miss them, 12px apart, and legible.
 *      Apple is the first choice (solid black), Google the quiet alternative
 *      (white with a hairline edge) — and NEITHER may look switched off.
 *
 *   3. The reassurance line under them reads as a sentence, not a button. It
 *      used to be a blue pill, which people tapped. It also has to clear the
 *      4.5:1 contrast floor against the canvas, which accent-blue text did not.
 *
 * jsdom cannot prove any of that: it has no layout and no colour. So this
 * builds the same shell `app/providers.tsx` gives the route, compiles the real
 * `app/globals.css`, and measures.
 *
 * The class strings are READ OUT OF THE COMPONENTS at run time rather than
 * copied here. A fixture holding its own copy of the markup passes forever
 * after the screen changes underneath it.
 *
 * Run with: npm run test:layout-contracts
 */

/** iPhone SE through the largest phone. iOS is where the users are. */
const WIDTHS = [320, 375, 390, 430] as const;
const HEIGHT = 844;

/** What the design asks for, and what a thumb needs. */
const BUTTON_MIN_H = 54;
const BUTTON_MAX_H = 56;
const RADIUS_MIN = 16;
const RADIUS_MAX = 18;
const BUTTON_GAP = 12;

/** WCAG AA for normal-size text. */
const CONTRAST_FLOOR = 4.5;

/** Sub-pixel line boxes only. A real regression lands tens of px over. */
const SLACK_PX = 1;

const webappRoot = process.cwd();

function readSource(repoPath: string): string {
  return fs.readFileSync(path.join(webappRoot, repoPath), "utf8");
}

/**
 * Pull a `const NAME = "..."` / `const NAME = \`...\`` string out of a source
 * file and resolve any `${OTHER}` references against the same file.
 *
 * Throws rather than returning an empty string: a spec that silently measures
 * `class=""` reports a passing button that does not exist.
 */
function classConstant(source: string, name: string, seen = 0): string {
  const match = source.match(
    new RegExp(`const ${name} =\\s*(?:"([^"]*)"|\`([^\`]*)\`)`),
  );
  if (!match) {
    throw new Error(
      `auth-sign-in.layout: could not find "const ${name}" in AuthStep.tsx. ` +
        `It was renamed or removed — update this spec so it measures the real class.`,
    );
  }
  const raw = match[1] ?? match[2] ?? "";
  if (seen > 5) return raw;
  return raw.replace(/\$\{(\w+)\}/g, (_, ref: string) =>
    classConstant(source, ref, seen + 1),
  );
}

/**
 * The colour actually painted behind the sign-in text.
 *
 * It is NOT `--app-grouped-background`. The shared hero background paints its
 * own opaque sheet over the app canvas, and which sheet depends on the variant
 * the screen asks for — so contrast measured against the app token would be
 * measured against a surface nobody sees. Derived from the two real sources.
 */
function paintedCanvas(auth: string): { light: string; dark: string } {
  if (!auth.includes('variant="plain"')) {
    return {
      light: "var(--app-grouped-background)",
      dark: "var(--app-grouped-background)",
    };
  }
  const css = readSource(
    "components/onboarding/OnboardingHeroBackground.module.css",
  );
  const light = css.match(/\.plainBase\s*\{[^}]*background:\s*([^;]+);/)?.[1];
  const dark = css.match(
    /:global\(\.dark\)\s*\.plainBase\s*\{[^}]*background:\s*([^;]+);/,
  )?.[1];
  if (!light || !dark) {
    throw new Error(
      "auth-sign-in.layout: the sign-in screen asks for the plain hero canvas, " +
        "but its light and dark backgrounds are no longer both declared — this " +
        "spec would measure contrast against a surface the screen never paints.",
    );
  }
  return { light: light.trim(), dark: dark.trim() };
}

/** Pull the first capture of `pattern`, or explain what to fix. */
function capture(source: string, pattern: RegExp, what: string): string {
  const found = source.match(pattern)?.[1];
  if (!found) {
    throw new Error(
      `auth-sign-in.layout: ${what} no longer matches AuthStep.tsx. ` +
        `Update this spec so it keeps measuring the real screen instead of an empty box.`,
    );
  }
  return found;
}

/**
 * Pull an inline `style={{ ... }}` object out of the source and turn it into
 * CSS text.
 *
 * This is read rather than copied for one specific reason: the difference
 * between `min-height` and `height` on these two boxes is the difference
 * between content that scrolls and content that silently disappears. A fixture
 * holding its own copy of the sizing would keep passing after the component
 * regressed.
 */
function inlineStyleAfter(source: string, marker: string): string {
  const at = source.indexOf(marker);
  if (at < 0) {
    throw new Error(
      `auth-sign-in.layout: ${JSON.stringify(marker)} is gone from AuthStep.tsx.`,
    );
  }
  const window = source.slice(Math.max(0, at - 600), at);
  const block = window.match(/style=\{\{([\s\S]*?)\}\}/g)?.pop();
  if (!block) {
    throw new Error(
      `auth-sign-in.layout: no inline style found before ${JSON.stringify(marker)}.`,
    );
  }
  return [...block.matchAll(/(\w+):\s*"([^"]*)"/g)]
    .map(
      ([, prop, value]) =>
        `${prop.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())}: ${value};`,
    )
    .join(" ");
}

/** Pull a `className="..."` literal identified by a nearby unique marker. */
function classNameNear(
  source: string,
  marker: string,
  { before = 900 }: { before?: number } = {},
): string {
  const at = source.indexOf(marker);
  if (at < 0) {
    throw new Error(
      `auth-sign-in.layout: marker ${JSON.stringify(marker)} is gone from AuthStep.tsx.`,
    );
  }
  const window = source.slice(Math.max(0, at - before), at);
  const all = [...window.matchAll(/className="([^"]*)"/g)];
  if (!all.length) {
    throw new Error(
      `auth-sign-in.layout: no className found before ${JSON.stringify(marker)}.`,
    );
  }
  return all[all.length - 1][1];
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

type Pieces = {
  primitive: string;
  apple: string;
  google: string;
  logoBox: string;
  halo: string;
  title: string;
  supporting: string;
  privacyRow: string;
  privacyText: string;
  legal: string;
  clusters: string;
  identity: string;
  titlePair: string;
  actionsWrap: string;
  providerActions: string;
  supportingWrap: string;
  canvas: { light: string; dark: string };
  mainStyle: string;
  contentStyle: string;
};

function readPieces(): Pieces {
  const auth = readSource("components/onboarding/AuthStep.tsx");
  const button = readSource("components/onboarding/AuthProviderButton.tsx");

  // The primitive's own classes, plus what `size="lg"` contributes from
  // components/ui/button.tsx. Both are on the rendered <button>.
  const primitiveOwn = (button.match(/cn\(\s*\n\s*"([^"]*)"/) ?? [])[1];
  if (!primitiveOwn) {
    throw new Error(
      "auth-sign-in.layout: AuthProviderButton's base className moved — update this spec.",
    );
  }
  const sizeLg = (readSource("components/ui/button.tsx").match(
    /lg:\s*"([^"]*)"/,
  ) ?? [])[1];
  if (!sizeLg) {
    throw new Error(
      'auth-sign-in.layout: the button `size: lg` variant moved — update this spec.',
    );
  }

  return {
    // `w-full` is what `fullWidth` on the morphy Button resolves to
    // (lib/morphy-ux/button.tsx). Without it the fixture sizes each button to
    // its own label and the pair is never the same width.
    primitive: `${sizeLg} w-full ${primitiveOwn}`,
    apple: classConstant(auth, "APPLE_BTN_CLASS"),
    google: classConstant(auth, "GOOGLE_BTN_CLASS"),
    logoBox: classNameNear(auth, "🤫", { before: 400 }).replace(
      /\s*relative select-none.*/,
      "",
    ),
    halo: capture(
      auth,
      /className="(pointer-events-none absolute[^"]*)"/,
      "the logo halo",
    ),
    title: classNameNear(auth, "Welcome to One\n"),
    supporting: classNameNear(auth, "Sign in to continue."),
    privacyRow: classNameNear(auth, "icon={Lock}"),
    privacyText: classNameNear(auth, "You choose what One can see."),
    legal: classNameNear(auth, "By continuing you agree to our"),
    clusters: classNameNear(auth, "data-auth-signin-clusters"),
    identity: capture(
      auth,
      /className="(flex flex-col items-center gap-4)"/,
      "the identity column",
    ),
    titlePair: capture(
      auth,
      /className="(flex flex-col items-center gap-1\.5)"/,
      "the title/supporting pair",
    ),
    actionsWrap: capture(
      auth,
      /className="(relative mx-auto w-full max-w-\[[^\]]*\] space-y-4)"/,
      "the actions wrapper",
    ),
    providerActions: capture(
      auth,
      /className="(space-y-3)" data-auth-provider-actions/,
      "the provider button stack",
    ),
    supportingWrap: capture(
      auth,
      /className="(flex flex-col items-center gap-3)" data-auth-supporting-content/,
      "the supporting content column",
    ),
    canvas: paintedCanvas(auth),
    mainStyle: inlineStyleAfter(auth, 'data-testid="auth-step-primary"'),
    contentStyle: inlineStyleAfter(auth, "data-auth-content-block"),
  };
}

/**
 * The shell `app/providers.tsx` builds for /login: `mode: "hidden"` in the
 * route contract selects the branch where the scroll root reserves the Talk to
 * One bar and re-adds it as its own padding-bottom.
 */
function shellMarkup(p: Pieces): string {
  const glyph = (label: string) =>
    `<svg class="size-5" viewBox="0 0 24 24" aria-hidden><title>${label}</title><path fill="currentColor" d="M4 4h16v16H4z"/></svg>`;

  const providerButton = (id: string, label: string, cls: string) =>
    `<button type="button" data-provider="${id}" class="${cn(p.primitive, cls)}">
       <span class="inline-flex items-center gap-3">${glyph(label)}<span>${label}</span></span>
     </button>`;

  return `<div data-app-shell-root="true" style="--app-scroll-bottom-pad: calc(var(--onboarding-agent-bar-clearance) + 1.5rem); position: fixed; inset: 0; display: flex; flex-direction: column;">
    <div
      data-app-scroll-root="true"
      style="flex: 1 1 0%; min-height: 0; overflow-y: auto; padding-bottom: var(--app-scroll-bottom-pad);"
    >
      <main
        class="relative w-full overflow-hidden"
        style="${p.mainStyle}"
        data-testid="auth-step-primary"
      >
        <div
          class="relative mx-auto flex w-full max-w-[440px] flex-col justify-center"
          style="${p.contentStyle}"
          data-auth-content-block
        >
          <div class="${p.clusters}" data-auth-signin-clusters>
            <div class="${p.identity}">
              <div class="${p.logoBox}" aria-hidden="true">
                <span class="${p.halo}"></span>
                <span class="relative select-none text-[52px] leading-none">🤫</span>
              </div>
              <div class="${p.titlePair}">
                <h1 role="heading" aria-level="1" aria-label="Welcome to One" class="${p.title}">Welcome to One</h1>
                <p class="${p.supporting}">Sign in to continue.</p>
              </div>
            </div>
            <div class="${p.actionsWrap}">
              <div class="${p.providerActions}" data-auth-provider-actions>
                ${providerButton("apple", "Continue with Apple", p.apple)}
                ${providerButton("google", "Continue with Google", p.google)}
              </div>
              <div class="${p.supportingWrap}" data-auth-supporting-content>
                <div class="${p.privacyRow}" data-privacy-row>
                  <svg class="size-4" viewBox="0 0 24 24" aria-hidden style="color: var(--app-accent-deep)"><path fill="currentColor" d="M6 10h12v10H6z"/></svg>
                  <span class="${p.privacyText}">You choose what One can see.</span>
                </div>
                <p class="${p.legal}" data-legal>
                  By continuing you agree to our
                  <button type="button" class="font-semibold text-[color:var(--app-accent-deep)]">Terms</button>
                  <span aria-hidden> and </span>
                  <button type="button" class="font-semibold text-[color:var(--app-accent-deep)]">Privacy Policy</button>.
                </p>
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
    <div data-bottom-chrome style="position: fixed; inset-inline: 0; bottom: 0; height: var(--onboarding-agent-bar-clearance);"></div>
  </div>`;
}

async function writeFixture({
  textScale = 100,
  theme = "light",
}: { textScale?: number; theme?: "light" | "dark" } = {}): Promise<string> {
  const pieces = readPieces();
  const candidates = [
    pieces.primitive,
    pieces.apple,
    pieces.google,
    pieces.logoBox,
    pieces.halo,
    pieces.title,
    pieces.supporting,
    pieces.privacyRow,
    pieces.privacyText,
    pieces.legal,
    pieces.clusters,
    pieces.identity,
    pieces.titlePair,
    pieces.actionsWrap,
    pieces.providerActions,
    pieces.supportingWrap,
    "dark foundation-public-ambient size-4 size-5 inline-flex items-center gap-3 relative select-none text-[52px] leading-none font-semibold text-[color:var(--app-accent-deep)] relative w-full overflow-hidden",
  ]
    .join(" ")
    .split(/\s+/)
    .filter(Boolean);

  const css = await buildStylesheet(candidates);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "auth-sign-in-layout-"));
  fs.writeFileSync(path.join(dir, "fixture.css"), css);
  fs.writeFileSync(
    path.join(dir, "fixture.html"),
    `<!doctype html><html><head><meta charset="utf-8">
<style>${productFontStyle()}</style>
<link rel="stylesheet" href="fixture.css">
<style>
  html { font-size: ${textScale}%; }
  body { margin: 0; }
  /* Matches the class on the body element so it wins: a class selector
     outranks a bare element rule, and the sheet the screen really paints has
     to be the one contrast is measured against. */
  body.foundation-public-ambient { background: ${pieces.canvas.light}; }
  body.dark.foundation-public-ambient { background: ${pieces.canvas.dark}; }
</style></head>
<body class="foundation-public-ambient ${theme === "dark" ? "dark" : ""}" data-ambient-chrome-primed="true">${shellMarkup(pieces)}</body></html>`,
  );
  return `file://${path.join(dir, "fixture.html")}`;
}

/** Relative luminance contrast, computed from the pixels the browser resolved. */
const CONTRAST_HELPERS = `
  const toRgb = (value) => {
    const parts = String(value).match(/[\\d.]+/g);
    if (!parts) return null;
    return { r: +parts[0], g: +parts[1], b: +parts[2], a: parts.length > 3 ? +parts[3] : 1 };
  };
  const luminance = (c) => {
    const channel = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
  };
  const contrast = (a, b) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
`;

test.describe("sign-in screen layout", () => {
  for (const width of WIDTHS) {
    test(`fits one screen with nothing cut off at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: HEIGHT });
      await page.goto(await writeFixture());
      await awaitProductFont(page);

      const measured = await page.evaluate(() => {
        const scrollRoot = document.querySelector<HTMLElement>(
          "[data-app-scroll-root]",
        )!;
        const main = document.querySelector<HTMLElement>(
          '[data-testid="auth-step-primary"]',
        )!;
        const clusters = document.querySelector<HTMLElement>(
          "[data-auth-signin-clusters]",
        )!;
        const mainBox = main.getBoundingClientRect();

        // `overflow-hidden` means content past the box does not scroll, it
        // vanishes. Anything real (not a decorative, aria-hidden glow) that
        // leaves the box is content the user can never reach.
        const cut = [...clusters.querySelectorAll<HTMLElement>("*")]
          .filter((el) => !el.closest('[aria-hidden="true"]'))
          .filter((el) => {
            const r = el.getBoundingClientRect();
            return (
              r.height > 0 &&
              (r.bottom > mainBox.bottom + 0.5 || r.top < mainBox.top - 0.5)
            );
          })
          .map((el) => el.tagName + "." + String(el.className).slice(0, 40));

        return {
          overflow: scrollRoot.scrollHeight - scrollRoot.clientHeight,
          mainHeight: +mainBox.height.toFixed(2),
          clusterHeight: +clusters.getBoundingClientRect().height.toFixed(2),
          horizontal:
            document.documentElement.scrollWidth -
            document.documentElement.clientWidth,
          cut,
        };
      });

      expect(
        measured.clusterHeight,
        "fixture rendered nothing — the class extraction is measuring an empty page",
      ).toBeGreaterThan(200);

      expect(
        measured.overflow,
        `the sign-in screen scrolls ${measured.overflow}px at ${width}x${HEIGHT}`,
      ).toBeLessThanOrEqual(SLACK_PX);

      expect(
        measured.horizontal,
        `the sign-in screen scrolls sideways ${measured.horizontal}px at ${width}px`,
      ).toBeLessThanOrEqual(SLACK_PX);

      expect(
        measured.cut,
        `content is cut off the sign-in screen at ${width}px (a fixed height plus overflow-hidden hides it with no scrollbar): ${measured.cut.join(", ")}`,
      ).toEqual([]);
    });

    test(`nothing is cut off when text is doubled at ${width}px`, async ({
      page,
    }) => {
      // The real report: at 200% text the mark and the title were gone. The
      // bottom reservation is measured in rem, so it doubles too and the box
      // gets SHORTER exactly as the content gets taller. With a fixed height
      // and overflow-hidden the difference is not scrolled, it is thrown away.
      // Here the screen is allowed — expected — to scroll. What it may never do
      // is hide something.
      await page.setViewportSize({ width, height: HEIGHT });
      await page.goto(await writeFixture({ textScale: 200 }));
      await awaitProductFont(page);

      const measured = await page.evaluate(() => {
        const scrollRoot = document.querySelector<HTMLElement>(
          "[data-app-scroll-root]",
        )!;
        const main = document.querySelector<HTMLElement>(
          '[data-testid="auth-step-primary"]',
        )!;
        const clusters = document.querySelector<HTMLElement>(
          "[data-auth-signin-clusters]",
        )!;
        const mainBox = main.getBoundingClientRect();
        const cut = [...clusters.querySelectorAll<HTMLElement>("*")]
          .filter((el) => !el.closest('[aria-hidden="true"]'))
          .filter((el) => {
            const r = el.getBoundingClientRect();
            return (
              r.height > 0 &&
              (r.bottom > mainBox.bottom + 0.5 || r.top < mainBox.top - 0.5)
            );
          })
          .map((el) => el.tagName + "." + String(el.className).slice(0, 40));
        return {
          cut,
          clusterHeight: +clusters.getBoundingClientRect().height.toFixed(2),
          mainHeight: +mainBox.height.toFixed(2),
          reserve: Number.parseFloat(
            getComputedStyle(scrollRoot).paddingBottom || "0",
          ),
        };
      });

      // Proves the case is real: at 200% the content genuinely outgrows the
      // one-viewport minimum. Without this, a fixture that happened to stay
      // short would pass the assertion below while proving nothing.
      expect(
        measured.clusterHeight,
        `at 200% text the sign-in block is only ${measured.clusterHeight}px — this no longer exercises the overflow case`,
      ).toBeGreaterThan(HEIGHT - measured.reserve);

      expect(
        measured.cut,
        `at 200% text these are cut off the sign-in screen at ${width}px, with no scrollbar to reach them: ${measured.cut.join(", ")}`,
      ).toEqual([]);
    });

    for (const theme of ["light", "dark"] as const) {
    test(`the two sign-in buttons read as one pair at ${width}px (${theme})`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: HEIGHT });
      await page.goto(await writeFixture({ theme }));
      await awaitProductFont(page);

      const measured = await page.evaluate(`(() => {
        ${CONTRAST_HELPERS}
        const read = (id) => {
          const el = document.querySelector('[data-provider="' + id + '"]');
          const box = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          return {
            top: box.top, bottom: box.bottom,
            width: +box.width.toFixed(2), height: +box.height.toFixed(2),
            radius: Number.parseFloat(cs.borderTopLeftRadius),
            bg: cs.backgroundColor,
            fg: cs.color,
            borderWidth: Number.parseFloat(cs.borderTopWidth),
            borderColor: cs.borderTopColor,
            shadow: cs.boxShadow,
            opacity: Number.parseFloat(cs.opacity),
            contrast: contrast(toRgb(cs.backgroundColor), toRgb(cs.color)),
            canvasContrast: contrast(
              toRgb(cs.backgroundColor),
              toRgb(getComputedStyle(document.body).backgroundColor),
            ),
            bgAlpha: toRgb(cs.backgroundColor).a,
          };
        };
        const apple = read('apple');
        const google = read('google');
        return { apple, google, gap: +(google.top - apple.bottom).toFixed(2) };
      })()`) as {
        apple: Record<string, number | string>;
        google: Record<string, number | string>;
        gap: number;
      };

      for (const [name, button] of [
        ["Apple", measured.apple],
        ["Google", measured.google],
      ] as const) {
        expect(
          button.height as number,
          `the ${name} button is ${button.height}px tall at ${width}px`,
        ).toBeGreaterThanOrEqual(BUTTON_MIN_H);
        expect(
          button.height as number,
          `the ${name} button is ${button.height}px tall at ${width}px`,
        ).toBeLessThanOrEqual(BUTTON_MAX_H);

        expect(
          button.radius as number,
          `the ${name} button's corner radius is ${button.radius}px`,
        ).toBeGreaterThanOrEqual(RADIUS_MIN);
        expect(
          button.radius as number,
          `the ${name} button's corner radius is ${button.radius}px`,
        ).toBeLessThanOrEqual(RADIUS_MAX);

        // A see-through fill is how a live button starts looking switched off.
        expect(
          button.bgAlpha as number,
          `the ${name} button's fill is ${button.bg} — a live sign-in button must be solid`,
        ).toBe(1);
        expect(
          button.opacity as number,
          `the ${name} button renders at ${button.opacity} opacity and reads as disabled`,
        ).toBe(1);

        expect(
          button.contrast as number,
          `the ${name} button's label is ${String(button.contrast).slice(0, 4)}:1 against its own fill`,
        ).toBeGreaterThanOrEqual(CONTRAST_FLOOR);
      }

      expect(
        measured.apple.width,
        "the two sign-in buttons are different widths",
      ).toBe(measured.google.width);

      expect(
        measured.gap,
        `the sign-in buttons sit ${measured.gap}px apart`,
      ).toBeCloseTo(BUTTON_GAP, 0);

      // Apple is the first choice: a dark fill against Google's light one.
      // Same-coloured buttons give the screen two equal primaries.
      expect(
        measured.apple.bg,
        "the Apple and Google buttons have the same fill, so neither reads as the first choice",
      ).not.toBe(measured.google.bg);

      // Google is a card on a near-white canvas: without an edge it dissolves.
      expect(
        measured.google.borderWidth as number,
        "the Google button has no visible edge against the canvas",
      ).toBeGreaterThan(0);

      // The first choice has to be the one that stands out ON THIS SHEET.
      // Painting Apple black in dark mode leaves a black card on a black
      // canvas beside a bright white Google button, and the quiet option is
      // the one that shouts.
      expect(
        measured.apple.canvasContrast as number,
        `on the ${theme} sheet the Apple button stands out ${String(measured.apple.canvasContrast).slice(0, 4)}:1 from the canvas and Google ${String(measured.google.canvasContrast).slice(0, 4)}:1 — the quiet option is louder than the first choice`,
      ).toBeGreaterThan(measured.google.canvasContrast as number);
    });
    }

    test(`the reassurance line reads as text, not a button, at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: HEIGHT });
      await page.goto(await writeFixture());
      await awaitProductFont(page);

      const measured = await page.evaluate(`(() => {
        ${CONTRAST_HELPERS}
        const canvas = toRgb(getComputedStyle(document.body).backgroundColor);
        const row = document.querySelector('[data-privacy-row]');
        const rowStyle = getComputedStyle(row);
        const text = row.querySelector('span');
        const legal = document.querySelector('[data-legal]');
        return {
          rowBgAlpha: toRgb(rowStyle.backgroundColor).a,
          rowBorder: Number.parseFloat(rowStyle.borderTopWidth),
          rowShadow: rowStyle.boxShadow,
          rowRadius: Number.parseFloat(rowStyle.borderTopLeftRadius),
          textSize: Number.parseFloat(getComputedStyle(text).fontSize),
          textContrast: contrast(toRgb(getComputedStyle(text).color), canvas),
          legalSize: Number.parseFloat(getComputedStyle(legal).fontSize),
          legalContrast: contrast(toRgb(getComputedStyle(legal).color), canvas),
          canvas: getComputedStyle(document.body).backgroundColor,
        };
      })()`) as Record<string, number | string>;

      expect(
        measured.rowBgAlpha as number,
        "the reassurance line has a filled background, which is what made people tap it",
      ).toBe(0);
      expect(
        measured.rowBorder as number,
        "the reassurance line has a border and reads as a control",
      ).toBe(0);
      expect(
        measured.rowShadow,
        "the reassurance line has a shadow and reads as a control",
      ).toBe("none");

      expect(
        measured.textContrast as number,
        `the reassurance line is ${String(measured.textContrast).slice(0, 4)}:1 against ${measured.canvas}`,
      ).toBeGreaterThanOrEqual(CONTRAST_FLOOR);

      expect(
        measured.legalContrast as number,
        `the terms line is ${String(measured.legalContrast).slice(0, 4)}:1 against ${measured.canvas}`,
      ).toBeGreaterThanOrEqual(CONTRAST_FLOOR);

      // Nobody over 60 reads 11px grey. Both lines stay in the readable band,
      // and the reassurance sits one step above the legal note.
      expect(measured.legalSize as number).toBeGreaterThanOrEqual(13);
      expect(measured.textSize as number).toBeGreaterThan(
        measured.legalSize as number,
      );
    });
  }
});
