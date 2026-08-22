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
  CIRCLE_MEMBER_ACTION_CLASSNAME,
  CIRCLE_MEMBER_AVATAR_CLASSNAME,
  CIRCLE_MEMBER_MENU_CLASSNAME,
  CIRCLE_MEMBER_ROW_CLASSNAME,
  CIRCLE_MEMBER_ROW_MIN_HEIGHT_PX,
  CIRCLE_MEMBER_MENU_SLOT_PX,
  CIRCLE_MEMBER_TRAILING_CLASSNAME,
} from "../components/one-location/redesign/circles/circle-member-row-layout";
import { buttonVariants } from "../components/ui/button";
import { cn } from "../lib/utils";

/**
 * One QA report, photographed on a phone: the Circle roster "is seriously not
 * looking good ... alignment and placement ... it should not look scattered".
 *
 * The cause was measurable rather than a matter of taste. A roster row renders
 * up to two trailing things, and one circle produces every combination of them
 * at once -- the owner has a kebab, a member you cannot share to has none, your
 * own row has neither, and until this change every row also carried a disabled
 * "Connected" pill. Each row sized its own trailing cluster to its own content,
 * so the same control landed at three different x positions down four rows.
 *
 * None of that is visible to the JSDOM suite, which applies no CSS and measures
 * every element as 0x0: a `className.toContain(...)` assertion would have passed
 * for as long as the screen was wrong. So the sibling JSDOM test proves the
 * component still renders these class strings, and this file proves what the
 * strings DO -- in the real Tailwind cascade, at the real type, across the phone
 * widths the product ships on.
 *
 * The screen is behind sign-in, so reaching it would need a reviewer fixture and
 * a live backend. This renders the real class strings, imported from the module
 * the screen itself imports, exactly as `connect-circle-cta.layout.spec.ts` does.
 *
 * Run with: npm run test:layout-contracts
 */

/** Every common iPhone width, plus one tablet reference. `sm:` is 640px, so
 *  everything below that is what actually ships to the App Store. */
const PHONE_WIDTHS = [320, 360, 375, 390, 430] as const;
const WIDTHS = [...PHONE_WIDTHS, 768] as const;

/** The app's horizontal page padding at phone widths, as a conservative floor.
 *  Assuming LESS room than the screen really has can only make these stricter. */
const PAGE_PADDING_PX = 16;

/**
 * The real stylesheet, compiled once per fixture.
 *
 * `globals.css` rather than a bare `@import "tailwindcss"`: the type this
 * measures is defined there, not in Tailwind. `ui-text-row-description` sets the
 * roster's second line through `--type-row-description-*`, and compiling without
 * it would measure a default 16px line and quietly prove nothing about the row
 * that shipped.
 *
 * `@source` directives are stripped: they widen the scanner across the component
 * tree for the real build, and here the candidate list is explicit.
 */
async function buildStylesheet(candidates: string[]): Promise<string> {
  // Playwright runs from the webapp root (its config lives there).
  const webappRoot = process.cwd();
  const { compile } = (await import(
    path.join(webappRoot, "node_modules/tailwindcss/dist/lib.mjs")
  )) as {
    compile: (
      css: string,
      opts: unknown,
    ) => Promise<{ build: (c: string[]) => string }>;
  };

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
            ? path.join(webappRoot, "node_modules/tw-animate-css/dist/tw-animate.css")
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

/**
 * Write a fixture directory and return its `file://` URL.
 *
 * The real Inter face is copied in and the stylesheet's absolute `/fonts/...`
 * URLs rewritten to point at it. Without that step the page falls back to a
 * system font, and a row measured here would be a row of the wrong typeface.
 */
async function buildFixture(name: string, body: string, candidates: string[]) {
  const webappRoot = process.cwd();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));

  let css = await buildStylesheet(candidates);

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

/** Box geometry, as a human reads it off a screenshot. */
interface Box {
  top: number;
  bottom: number;
  left: number;
  right: number;
  width: number;
  height: number;
  /**
   * The row separators' own thickness.
   *
   * `divide-y` gives every child but the last a 1px `border-bottom`, and
   * `getBoundingClientRect` counts it -- so an otherwise perfect roster
   * measures its LAST row 1px shorter than the rest, and a height assertion
   * fails on the hairline between the rows rather than on the rows. Both
   * edges are read because which one the utility uses is Tailwind's business,
   * not this file's.
   */
  borderTop: number;
  borderBottom: number;
}

/** The selector is passed as an argument, never captured: `page.evaluate` ships
 *  the function's source to the browser, where a closure variable from this file
 *  would arrive undefined. */
function boxesOf(page: Page, selector: string): Promise<Box[]> {
  return page.evaluate((sel) => {
    return Array.from(document.querySelectorAll(sel)).map((node) => {
      const r = node.getBoundingClientRect();
      return {
        top: r.top,
        bottom: r.bottom,
        left: r.left,
        right: r.right,
        width: r.width,
        height: r.height,
        borderTop:
          parseFloat(getComputedStyle(node).borderTopWidth || "0") || 0,
        borderBottom:
          parseFloat(getComputedStyle(node).borderBottomWidth || "0") || 0,
      };
    });
  }, selector);
}

/** What the row is, with the separators around it discounted. */
const contentHeight = (box: Box) =>
  box.height - box.borderTop - box.borderBottom;

/** The row's own centre line, likewise. */
const contentCentre = (box: Box) =>
  box.top + box.borderTop + contentHeight(box) / 2;

const spread = (values: number[]) => Math.max(...values) - Math.min(...values);

// ---------------------------------------------------------------------------
// The roster, exactly as the component composes it
// ---------------------------------------------------------------------------

const connectClass = cn(
  buttonVariants({ variant: "default", size: "sm" }),
  CIRCLE_MEMBER_ACTION_CLASSNAME,
);

const MENU_GLYPH = "&#8942;"; // ⋮

/** The four trailing combinations one circle really produces at once. */
type RosterRow = {
  name: string;
  secondary: string;
  action: "connect" | "none";
  menu: boolean;
};

const ROSTER: RosterRow[] = [
  // The owner: nothing to ask for, but shareable, so a kebab.
  { name: "Divya Rajendran", secondary: "Circle owner", action: "none", menu: true },
  // You: neither control applies.
  {
    name: "JHUMMA KUMARI (you)",
    secondary: "Ready for private sharing",
    action: "none",
    menu: false,
  },
  // A stranger you cannot share to yet: an action, no kebab.
  {
    name: "Sharu Khan",
    secondary: "Location setup needed",
    action: "connect",
    menu: false,
  },
  // A stranger you can: both.
  {
    name: "Wilhelmina Featherstonehaugh-Rajendran",
    secondary: "Ready for private sharing",
    action: "connect",
    menu: true,
  },
];

function rosterBody(rows: RosterRow[], legacy = false): string {
  const cells = rows
    .map((row, index) => {
      const action =
        row.action === "connect"
          ? `<button data-testid="row-action" class="${connectClass}">Connect</button>`
          : legacy
            ? // What shipped: a disabled pill on EVERY row, connected included.
              `<button data-testid="row-action" disabled class="${cn(
                buttonVariants({ variant: "secondary", size: "sm" }),
                "mt-0.5 h-9 shrink-0 rounded-full",
              )}">Connected</button>`
            : "";
      const menu = row.menu
        ? `<button data-testid="row-menu" class="${cn(
            buttonVariants({ variant: "ghost", size: "icon" }),
            CIRCLE_MEMBER_MENU_CLASSNAME,
          )}">${MENU_GLYPH}</button>`
        : legacy
          ? // What shipped: nothing at all, so the column collapsed.
            ""
          : `<span data-testid="row-menu" aria-hidden="true" class="${CIRCLE_MEMBER_MENU_CLASSNAME}"></span>`;

      const rowClass = legacy
        ? "flex items-start gap-3 px-4 py-3"
        : CIRCLE_MEMBER_ROW_CLASSNAME;
      const nameClass = legacy
        ? "break-words text-[15px] font-semibold leading-snug text-foreground"
        : "truncate text-[15px] font-semibold leading-5 text-foreground";

      return `<div data-testid="row" data-row="${index}" class="${rowClass}">
  <span data-testid="row-avatar" class="${cn(
    CIRCLE_MEMBER_AVATAR_CLASSNAME,
    "inline-flex items-center justify-center rounded-full bg-muted",
  )}">DR</span>
  <div class="min-w-0 flex-1">
    <p data-testid="row-name" class="${nameClass}">${row.name}</p>
    <p class="ui-text-row-description truncate">${row.secondary}</p>
  </div>
  ${
    legacy
      ? `${action}${menu}`
      : `<div class="${CIRCLE_MEMBER_TRAILING_CLASSNAME}">${action}${menu}</div>`
  }
</div>`;
    })
    .join("\n");

  return `<div class="rounded-[var(--app-card-radius-standard,24px)] bg-[color:var(--app-card-surface-default-solid)] divide-y divide-border/60">${cells}</div>`;
}

const CANDIDATES = [
  ...connectClass.split(/\s+/),
  ...cn(buttonVariants({ variant: "ghost", size: "icon" }), CIRCLE_MEMBER_MENU_CLASSNAME).split(/\s+/),
  ...cn(buttonVariants({ variant: "secondary", size: "sm" }), "mt-0.5 h-9 shrink-0 rounded-full").split(/\s+/),
  ...CIRCLE_MEMBER_ROW_CLASSNAME.split(/\s+/),
  ...CIRCLE_MEMBER_TRAILING_CLASSNAME.split(/\s+/),
  ...CIRCLE_MEMBER_AVATAR_CLASSNAME.split(/\s+/),
  ...CIRCLE_MEMBER_MENU_CLASSNAME.split(/\s+/),
  "flex",
  "items-start",
  "items-center",
  "inline-flex",
  "justify-center",
  "gap-3",
  "px-4",
  "py-3",
  "min-w-0",
  "flex-1",
  "truncate",
  "break-words",
  "rounded-full",
  "bg-muted",
  "text-[15px]",
  "font-semibold",
  "leading-5",
  "leading-snug",
  "text-foreground",
  "ui-text-row-description",
  "divide-y",
  "divide-border/60",
  "rounded-[var(--app-card-radius-standard,24px)]",
  "bg-[color:var(--app-card-surface-default-solid)]",
];

test.describe("Circle roster row", () => {
  for (const width of WIDTHS) {
    test(`every row ends on one column at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(
        await buildFixture("circle-member-row", rosterBody(ROSTER), CANDIDATES),
      );
      await awaitProductFont(page);

      const rows = await boxesOf(page, '[data-testid="row"]');
      const menus = await boxesOf(page, '[data-testid="row-menu"]');
      const names = await boxesOf(page, '[data-testid="row-name"]');
      const avatars = await boxesOf(page, '[data-testid="row-avatar"]');

      expect(rows).toHaveLength(ROSTER.length);
      // The spacer is what makes this true: the column exists on all four rows,
      // not only on the two that have a menu to put in it.
      expect(menus).toHaveLength(ROSTER.length);

      // The report, in one number. Before the spacer this spread was a full
      // 44px slot plus the gap beside it.
      expect(spread(menus.map((m) => m.right)), "menu column right edge").toBeLessThanOrEqual(0.5);
      expect(spread(menus.map((m) => m.left)), "menu column left edge").toBeLessThanOrEqual(0.5);
      for (const menu of menus) {
        expect(Math.abs(menu.width - CIRCLE_MEMBER_MENU_SLOT_PX)).toBeLessThanOrEqual(0.5);
      }

      // Names start on one column too, whatever each row happens to trail with.
      expect(spread(names.map((n) => n.left)), "name left edge").toBeLessThanOrEqual(0.5);
      expect(spread(avatars.map((a) => a.left)), "avatar left edge").toBeLessThanOrEqual(0.5);

      // One beat down the list. A name long enough to wrap used to double its
      // own row's height; `truncate` is what holds this flat.
      expect(
        spread(rows.map(contentHeight)),
        "row height",
      ).toBeLessThanOrEqual(0.5);
      for (const row of rows) {
        expect(contentHeight(row)).toBeGreaterThanOrEqual(
          CIRCLE_MEMBER_ROW_MIN_HEIGHT_PX - 0.5,
        );
      }

      // The avatar and the trailing control sit on the row's centre line, so
      // neither reads as floating above the name it belongs to.
      for (const [index, row] of rows.entries()) {
        const rowCentre = contentCentre(row);
        const avatarCentre = contentCentre(avatars[index]);
        const menuCentre = contentCentre(menus[index]);
        expect(Math.abs(avatarCentre - rowCentre), `row ${index}: avatar centre`).toBeLessThanOrEqual(1);
        expect(Math.abs(menuCentre - rowCentre), `row ${index}: menu centre`).toBeLessThanOrEqual(1);
      }

      // Nothing may push the page sideways, at any supported width.
      for (const menu of menus) {
        expect(menu.right).toBeLessThanOrEqual(width - PAGE_PADDING_PX + 1);
      }
      for (const avatar of avatars) {
        expect(avatar.left).toBeGreaterThanOrEqual(PAGE_PADDING_PX - 1);
      }
    });
  }

  test("the roster QA photographed really did stagger", async ({ page }) => {
    // Mutation check. Without it the assertions above could be passing on a
    // layout that was never capable of failing them.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(
      await buildFixture(
        "circle-member-row-legacy",
        rosterBody(ROSTER, true),
        CANDIDATES,
      ),
    );
    await awaitProductFont(page);

    const trailing = await boxesOf(
      page,
      '[data-testid="row-menu"], [data-testid="row-action"]',
    );
    const rows = await boxesOf(page, '[data-testid="row"]');

    // Rows 2 and 3 ended at the kebab; rows 1 and 4 ended at a pill, ~44px
    // further in. That difference is the photograph.
    expect(
      spread(trailing.map((box) => box.right)),
      "the shipped roster's trailing edge",
    ).toBeGreaterThan(20);

    // And the long name really did take its row to a different height.
    expect(
      spread(rows.map(contentHeight)),
      "the shipped row heights",
    ).toBeGreaterThan(4);
  });
});
