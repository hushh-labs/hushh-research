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
  CIRCLE_MEMBER_ACTIONS_MENU_SIDE_OFFSET_PX,
  CIRCLE_DETAIL_HEADER_CLASSNAME,
  CIRCLE_DETAIL_HEADER_COPY_CLASSNAME,
  CIRCLE_MEMBERS_CARD_SCROLL_CLASSNAME,
  CIRCLE_MEMBERS_CARD_SHELL_CLASSNAME,
  CIRCLE_LEAVE_ACTION_CLASSNAME,
  CIRCLE_PROCEED_TO_SMS_CLASSNAME,
  CIRCLE_MEMBER_ACTION_CLASSNAME,
  CIRCLE_MEMBER_ACTION_COPY_CLASSNAME,
  CIRCLE_MEMBER_STACKED_ACTION_CLASSNAME,
  CIRCLE_MEMBER_AVATAR_CLASSNAME,
  CIRCLE_MEMBER_NAME_CLASSNAME,
  CIRCLE_MEMBER_NAME_ROW_CLASSNAME,
  CIRCLE_MEMBER_MENU_CLASSNAME,
  CIRCLE_MEMBER_MENU_ITEM_CLASSNAME,
  CIRCLE_MEMBER_MENU_TRIGGER_CLASSNAME,
  CIRCLE_MEMBER_ROW_CLASSNAME,
  CIRCLE_MEMBER_ROW_MIN_HEIGHT_PX,
  CIRCLE_MEMBER_MENU_SLOT_PX,
  CIRCLE_MEMBER_SECONDARY_CLASSNAME,
  CIRCLE_MEMBER_TRAILING_CLASSNAME,
} from "../components/one-location/redesign/circles/circle-member-row-layout";
import { CARD_SURFACE } from "../lib/morphy-ux/tokens/surfaces";
import { buttonVariants } from "../lib/ui/button-variants";
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
const PHONE_WIDTHS = [320, 360, 393, 430, 600] as const;
const WIDTHS = [...PHONE_WIDTHS, 768, 1440] as const;

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

/**
 * Write a fixture directory and return its `file://` URL.
 *
 * The product font files are copied in and the stylesheet's absolute `/fonts/...`
 * URLs rewritten to point at it. Without that step the page falls back to a
 * system font, and a row measured here would be a row of the wrong typeface.
 */
async function buildFixture(name: string, body: string, candidates: string[]) {
  const webappRoot = process.cwd();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));

  let css = await buildStylesheet(candidates);

  const fontSource = path.join(webappRoot, "public/fonts/DM-Sans");
  if (fs.existsSync(fontSource)) {
    fs.cpSync(fontSource, path.join(dir, "fonts/DM-Sans"), { recursive: true });
    css = css.replace(/url\(["']?\/fonts\//g, 'url("./fonts/');
  }

  fs.writeFileSync(path.join(dir, "fixture.css"), css);
  fs.writeFileSync(
    path.join(dir, "fixture.html"),
    `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${productFontStyle()}</style>
<link rel="stylesheet" href="fixture.css"></head>
<body style="margin:0"><div style="padding:0 ${PAGE_PADDING_PX}px">${body}</div></body></html>`,
  );
  return `file://${path.join(dir, "fixture.html")}`;
}

/**
 * Mount the production actions component in a real browser without adding a
 * public test-only route to the Next.js application. Vite is already the
 * repository's Vitest compiler; here it serves a temporary entry point whose
 * only product import is `CircleMemberActionsMenu` itself. Radix therefore
 * owns the portal and popper geometry that the assertions measure.
 */
let productionMemberActionsStylesheet: Promise<string> | null = null;

function buildProductionMemberActionsStylesheet(): Promise<string> {
  productionMemberActionsStylesheet ??= (async () => {
    const webappRoot = process.cwd();
    const { Scanner } = await import("@tailwindcss/oxide");
    const sources = [
      "components/one-location/redesign/circles/circle-member-actions-menu.tsx",
      "components/one-location/redesign/circles/circle-member-row-layout.ts",
      "components/connections/connection-person-avatar.tsx",
      "components/ui/alert-dialog.tsx",
      "components/ui/avatar.tsx",
      "components/ui/button.tsx",
      "components/ui/drawer.tsx",
      "components/ui/dropdown-menu.tsx",
      "lib/ui/button-variants.ts",
    ].map((relativePath) => path.join(webappRoot, relativePath));
    const scanner = new Scanner({ sources: [] });
    const candidates = scanner.scanFiles(
      sources.map((file) => ({
        content: fs.readFileSync(file, "utf8"),
        extension: path.extname(file).slice(1),
      })),
    );
    return buildStylesheet([...new Set([...CANDIDATES, ...candidates])]);
  })();
  return productionMemberActionsStylesheet;
}

async function startProductionMemberActionsFixture() {
  const webappRoot = process.cwd();
  const fixturePrefix = "circle-member-actions-component-";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), fixturePrefix));
  const componentPath = path
    .join(
      webappRoot,
      "components/one-location/redesign/circles/circle-member-actions-menu.tsx",
    )
    .replaceAll("\\", "/");
  const memberName = "Wilhelmina Featherstonehaugh-Rajendran";

  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(
    path.join(dir, "fixture.css"),
    await buildProductionMemberActionsStylesheet(),
  );
  fs.writeFileSync(
    path.join(dir, "index.html"),
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${productFontStyle()}</style><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>`,
  );
  fs.writeFileSync(
    path.join(dir, "src/next-link.tsx"),
    `import type { AnchorHTMLAttributes, ReactNode } from "react";
export default function Link({ href, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: unknown; children: ReactNode }) {
  return <a href={typeof href === "string" ? href : "#"} {...props}>{children}</a>;
}`,
  );
  fs.writeFileSync(
    path.join(dir, "src/main.tsx"),
    `import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { CircleMemberActionsMenu } from "/@fs/${componentPath}";

const memberName = ${JSON.stringify(memberName)};
const noop = () => {};
const noopAsync = async () => {};

function PersonRow({ name, secondary, selected = false, children }: { name: string; secondary: string; selected?: boolean; children?: React.ReactNode }) {
  return (
    <div
      data-testid={selected ? "selected-row" : undefined}
      style={{ display: "flex", minHeight: 72, alignItems: "center", gap: 12, padding: "0 16px", borderTop: "1px solid var(--app-separator)" }}
    >
      <span aria-hidden="true" style={{ display: "inline-flex", width: 40, height: 40, flex: "0 0 40px", alignItems: "center", justifyContent: "center", borderRadius: 999, background: selected ? "#0b9dad" : "#7352c8", color: "white" }}>{name.slice(0, 1)}</span>
      <span data-testid={selected ? "selected-identity" : undefined} style={{ minWidth: 0, flex: 1 }}>
        <strong style={{ display: "block", overflowWrap: "anywhere", color: "var(--app-primary-label)" }}>{name}</strong>
        <small style={{ color: "var(--app-secondary-label)" }}>{secondary}</small>
      </span>
      {children ?? <span aria-hidden="true" style={{ width: 44, height: 44 }} />}
    </div>
  );
}

function App() {
  return (
    <main style={{ minHeight: "100vh", padding: "48px 24px", background: "var(--background)" }}>
      <section style={{ maxWidth: 720, margin: "0 auto", padding: "28px 24px", borderRadius: 24, background: "var(--app-primary-surface)", boxShadow: "var(--app-card-shadow-standard)" }}>
        <header style={{ marginBottom: 18 }}>
          <h1 style={{ margin: 0, color: "var(--app-primary-label)", fontSize: 28, lineHeight: "34px" }}>SMS Circle</h1>
          <p style={{ margin: "4px 0 0", color: "var(--app-secondary-label)", fontSize: 14 }}>3 people</p>
        </header>
        <div style={{ overflow: "visible", borderRadius: 20, background: "var(--app-card-surface-default-solid)" }}>
          <PersonRow name="Jhumma Kumari" secondary="Circle owner" />
          <PersonRow name={memberName} secondary="Connected" selected>
            <span data-testid="selected-controls" style={{ display: "inline-flex", flexShrink: 0, alignItems: "center", gap: 4 }}>
              <button data-testid="relationship-action" type="button" style={{ minHeight: 36, border: "1px solid var(--app-separator)", borderRadius: 999, padding: "0 14px", color: "var(--app-primary-label)" }}>Connect</button>
              <CircleMemberActionsMenu
                displayName={memberName}
                initials="WF"
                secondaryLine="Connected"
                canShare
                canRemove
                busy={false}
                onShare={noop}
                onRemove={noopAsync}
              />
            </span>
          </PersonRow>
          <PersonRow name="Gautam Ahuja" secondary="Connected" />
        </div>
      </section>
    </main>
  );
}

const container = document.getElementById("root")! as HTMLElement & { fixtureRoot?: Root };
// Vite may re-evaluate this fixture entrypoint after dependency optimization.
// Reuse its root so that the test observes component errors, not harness noise.
const root = container.fixtureRoot ??= createRoot(container);
root.render(<App />);`,
  );

  const [{ createServer }, { default: react }] = await Promise.all([
    import("vite"),
    import("@vitejs/plugin-react"),
  ]);
  const server = await createServer({
    root: dir,
    configFile: false,
    logLevel: "error",
    publicDir: path.join(webappRoot, "public"),
    plugins: [react()],
    resolve: {
      alias: [
        { find: "@", replacement: webappRoot },
        { find: "next/link", replacement: path.join(dir, "src/next-link.tsx") },
        {
          find: /^react\/jsx-dev-runtime$/,
          replacement: path.join(
            webappRoot,
            "node_modules/react/jsx-dev-runtime.js",
          ),
        },
        {
          find: /^react\/jsx-runtime$/,
          replacement: path.join(webappRoot, "node_modules/react/jsx-runtime.js"),
        },
        {
          find: /^react-dom\/client$/,
          replacement: path.join(webappRoot, "node_modules/react-dom/client.js"),
        },
        {
          find: /^react-dom$/,
          replacement: path.join(webappRoot, "node_modules/react-dom/index.js"),
        },
        {
          find: /^react$/,
          replacement: path.join(webappRoot, "node_modules/react/index.js"),
        },
      ],
      dedupe: ["react", "react-dom"],
    },
    server: {
      host: "127.0.0.1",
      port: 0,
      strictPort: false,
      fs: { allow: [webappRoot, dir] },
    },
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === "string") {
    await server.close();
    throw new Error("The production component fixture did not bind a port");
  }

  return {
    memberName,
    url: `http://127.0.0.1:${address.port}/`,
    async close() {
      await server.close();
      const resolvedDir = path.resolve(dir);
      if (
        path.dirname(resolvedDir) === path.resolve(os.tmpdir()) &&
        path.basename(resolvedDir).startsWith(fixturePrefix)
      ) {
        fs.rmSync(resolvedDir, { recursive: true, force: true });
      }
    },
  };
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

/** Relevant state rules from the shared DropdownMenuItem primitive. Keeping
 * them in the fixture is essential: the reported fade was a cascade conflict
 * between these generic rules and the Circle-specific neutral background. */
const DROPDOWN_ITEM_STATE_CLASSNAME =
  "focus:bg-accent focus:text-accent-foreground data-[disabled]:opacity-50 data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-[variant=destructive]:text-destructive";

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
  {
    name: "Divya Rajendran",
    secondary: "Circle owner",
    action: "none",
    menu: true,
  },
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
            CIRCLE_MEMBER_MENU_TRIGGER_CLASSNAME,
          )}">${MENU_GLYPH}</button>`
        : legacy
          ? // What shipped: nothing at all, so the column collapsed.
            ""
          : `<span data-testid="row-menu" aria-hidden="true" class="${CIRCLE_MEMBER_MENU_CLASSNAME}"></span>`;

      const rowClass = legacy
        ? "flex items-start gap-3 px-4 py-3"
        : CIRCLE_MEMBER_ROW_CLASSNAME;
      const nameMarkup = legacy
        ? `<p data-testid="row-name" class="break-words text-[15px] font-semibold leading-snug text-foreground">${row.name}</p>`
        : `<p class="${CIRCLE_MEMBER_NAME_ROW_CLASSNAME}"><span data-testid="row-name" class="${CIRCLE_MEMBER_NAME_CLASSNAME}">${row.name}</span></p>`;

      return `<div data-testid="row" data-row="${index}" class="${rowClass}">
  <span data-testid="row-avatar" class="${cn(
    CIRCLE_MEMBER_AVATAR_CLASSNAME,
    "inline-flex items-center justify-center rounded-full bg-muted",
  )}">DR</span>
  <div data-testid="row-copy" class="${cn("min-w-0 flex-1", !legacy && row.action !== "none" && CIRCLE_MEMBER_ACTION_COPY_CLASSNAME)}">
    ${nameMarkup}
    <p class="ui-text-row-description ${legacy ? "truncate" : CIRCLE_MEMBER_SECONDARY_CLASSNAME}">${row.secondary}</p>
  </div>
  ${
    legacy
      ? `${action}${menu}`
      : `<div class="${cn(CIRCLE_MEMBER_TRAILING_CLASSNAME, row.action !== "none" && CIRCLE_MEMBER_STACKED_ACTION_CLASSNAME)}">${action}${menu}</div>`
  }
</div>`;
    })
    .join("\n");

  return `<div class="rounded-[var(--app-card-radius-standard,24px)] bg-[color:var(--app-card-surface-default-solid)] divide-y divide-border/60">${cells}</div>`;
}

const CANDIDATES = [
  ...connectClass.split(/\s+/),
  ...cn(
    buttonVariants({ variant: "ghost", size: "icon" }),
    CIRCLE_MEMBER_MENU_TRIGGER_CLASSNAME,
  ).split(/\s+/),
  ...cn(
    buttonVariants({ variant: "secondary", size: "sm" }),
    "mt-0.5 h-9 shrink-0 rounded-full",
  ).split(/\s+/),
  ...CIRCLE_MEMBER_ROW_CLASSNAME.split(/\s+/),
  ...CIRCLE_MEMBER_TRAILING_CLASSNAME.split(/\s+/),
  ...CIRCLE_MEMBER_ACTION_COPY_CLASSNAME.split(/\s+/),
  ...CIRCLE_MEMBER_STACKED_ACTION_CLASSNAME.split(/\s+/),
  ...CIRCLE_MEMBER_AVATAR_CLASSNAME.split(/\s+/),
  ...CIRCLE_MEMBER_NAME_ROW_CLASSNAME.split(/\s+/),
  ...CIRCLE_MEMBER_NAME_CLASSNAME.split(/\s+/),
  ...CIRCLE_MEMBER_SECONDARY_CLASSNAME.split(/\s+/),
  ...CIRCLE_MEMBER_MENU_CLASSNAME.split(/\s+/),
  ...CIRCLE_MEMBER_MENU_ITEM_CLASSNAME.split(/\s+/),
  ...CIRCLE_MEMBER_MENU_TRIGGER_CLASSNAME.split(/\s+/),
  ...DROPDOWN_ITEM_STATE_CLASSNAME.split(/\s+/),
  ...CIRCLE_DETAIL_HEADER_CLASSNAME.split(/\s+/),
  ...CIRCLE_DETAIL_HEADER_COPY_CLASSNAME.split(/\s+/),
  ...CIRCLE_MEMBERS_CARD_SHELL_CLASSNAME.split(/\s+/),
  ...CIRCLE_MEMBERS_CARD_SCROLL_CLASSNAME.split(/\s+/),
  ...CIRCLE_LEAVE_ACTION_CLASSNAME.split(/\s+/),
  ...CIRCLE_PROCEED_TO_SMS_CLASSNAME.split(/\s+/),
  ...CARD_SURFACE.split(/\s+/),
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
  "ui-text-page-title",
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
      const copies = await boxesOf(page, '[data-testid="row-copy"]');

      const actionMenuGaps = await page.evaluate(() =>
        Array.from(
          document.querySelectorAll<HTMLElement>('[data-testid="row"]'),
        ).flatMap((row) => {
          const action = row.querySelector<HTMLElement>(
            '[data-testid="row-action"]',
          );
          const menu = row.querySelector<HTMLElement>(
            '[data-testid="row-menu"]',
          );
          if (!action || !menu) return [];
          const actionBox = action.getBoundingClientRect();
          const menuBox = menu.getBoundingClientRect();
          return [
            {
              gap: menuBox.left - actionBox.right,
              actionHeight: actionBox.height,
            },
          ];
        }),
      );

      expect(rows).toHaveLength(ROSTER.length);
      // The spacer is what makes this true: the column exists on all four rows,
      // not only on the two that have a menu to put in it.
      expect(menus).toHaveLength(ROSTER.length);

      // The report, in one number. Before the spacer this spread was a full
      // 44px slot plus the gap beside it.
      expect(
        spread(menus.map((m) => m.right)),
        "menu column right edge",
      ).toBeLessThanOrEqual(0.5);
      expect(
        spread(menus.map((m) => m.left)),
        "menu column left edge",
      ).toBeLessThanOrEqual(0.5);
      for (const menu of menus) {
        expect(
          Math.abs(menu.width - CIRCLE_MEMBER_MENU_SLOT_PX),
        ).toBeLessThanOrEqual(0.5);
      }

      // Names start on one column too, whatever each row happens to trail with.
      expect(
        spread(names.map((n) => n.left)),
        "name left edge",
      ).toBeLessThanOrEqual(0.5);
      expect(
        spread(avatars.map((a) => a.left)),
        "avatar left edge",
      ).toBeLessThanOrEqual(0.5);

      // Every row keeps the common minimum beat. Long identities may grow the
      // row instead of being replaced by an ellipsis.
      for (const row of rows) {
        // CSS min-height is border-box; a separator consumes one pixel within it.
        expect(row.height).toBeGreaterThanOrEqual(
          CIRCLE_MEMBER_ROW_MIN_HEIGHT_PX - 0.5,
        );
      }

      const nameMetrics = await page.evaluate(() =>
        Array.from(
          document.querySelectorAll<HTMLElement>('[data-testid="row-name"]'),
        ).map((node) => ({
          clientWidth: node.clientWidth,
          scrollWidth: node.scrollWidth,
          clientHeight: node.clientHeight,
          scrollHeight: node.scrollHeight,
          textOverflow: getComputedStyle(node).textOverflow,
          whiteSpace: getComputedStyle(node).whiteSpace,
        })),
      );
      for (const metric of nameMetrics) {
        expect(metric.scrollWidth).toBeLessThanOrEqual(metric.clientWidth + 1);
        expect(metric.scrollHeight).toBeLessThanOrEqual(
          metric.clientHeight + 1,
        );
        expect(metric.textOverflow).not.toBe("ellipsis");
        expect(metric.whiteSpace).not.toBe("nowrap");
      }

      if (width < 640) {
        expect(actionMenuGaps).toHaveLength(
          ROSTER.filter((row) => row.action !== "none").length,
        );
        for (const cluster of actionMenuGaps) {
          // The action and kebab are one compact trailing cluster. The old
          // `justify-between` pushed them to opposite edges of the second row.
          expect(cluster.gap).toBeGreaterThanOrEqual(3);
          expect(cluster.gap).toBeLessThanOrEqual(5);
          expect(cluster.actionHeight).toBeGreaterThanOrEqual(44);
        }
      }

      // The avatar and the trailing control sit on the row's centre line, so
      // neither reads as floating above the name it belongs to.
      for (const [index, row] of rows.entries()) {
        if (width < 640 && ROSTER[index].action !== "none") {
          expect(
            copies[index].width,
            "readable phone identity column",
          ).toBeGreaterThanOrEqual(190);
          expect(
            names[index].height,
            "long name uses at most three lines",
          ).toBeLessThanOrEqual(64);
          expect(menus[index].top).toBeGreaterThanOrEqual(copies[index].bottom);
          expect(
            Math.abs(
              contentCentre(avatars[index]) - contentCentre(copies[index]),
            ),
          ).toBeLessThanOrEqual(1);
          continue;
        }
        const rowCentre = contentCentre(row);
        const avatarCentre = contentCentre(avatars[index]);
        const menuCentre = contentCentre(menus[index]);
        expect(
          Math.abs(avatarCentre - rowCentre),
          `row ${index}: avatar centre`,
        ).toBeLessThanOrEqual(1);
        expect(
          Math.abs(menuCentre - rowCentre),
          `row ${index}: menu centre`,
        ).toBeLessThanOrEqual(1);
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

  test("opens the production desktop menu outside the selected row", async ({
    page,
  }, testInfo) => {
    const fixture = await startProductionMemberActionsFixture();
    const browserErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") browserErrors.push(message.text());
    });
    page.on("pageerror", (error) => browserErrors.push(error.message));

    try {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(fixture.url);
      await awaitProductFont(page);
      await expect(
        page.getByRole("heading", { name: "SMS Circle" }),
      ).toBeVisible();

      const trigger = page.getByRole("button", {
        name: `Actions for ${fixture.memberName}`,
      });
      await trigger.click();

      const menu = page.getByTestId("circle-member-actions-menu");
      await expect(menu).toBeVisible();
      await menu.evaluate(async (element) => {
        await Promise.all(
          element.getAnimations().map((animation) => animation.finished),
        );
      });
      await expect(menu).toHaveAttribute("data-side", "right");
      await expect(menu).toHaveAttribute("data-align", "center");
      await expect(
        page.getByTestId("circle-member-actions-menu-context"),
      ).toHaveText(`Actions for ${fixture.memberName}`);
      await expect(
        page.getByRole("menuitem", { name: "Share location" }),
      ).toBeVisible();
      await expect(
        page.getByRole("menuitem", { name: "Remove from Circle" }),
      ).toBeVisible();

      const [menuBox, triggerBox, selectedRow, selectedIdentity, relationship] =
        await Promise.all([
          boxesOf(page, '[data-testid="circle-member-actions-menu"]'),
          boxesOf(page, `button[aria-label="Actions for ${fixture.memberName}"]`),
          boxesOf(page, '[data-testid="selected-row"]'),
          boxesOf(page, '[data-testid="selected-identity"]'),
          boxesOf(page, '[data-testid="relationship-action"]'),
        ]);

      expect(
        Math.abs(contentCentre(menuBox[0]) - contentCentre(triggerBox[0])),
      ).toBeLessThanOrEqual(2);
      expect(
        Math.abs(
          menuBox[0].left -
            triggerBox[0].right -
            CIRCLE_MEMBER_ACTIONS_MENU_SIDE_OFFSET_PX,
        ),
      ).toBeLessThanOrEqual(2);
      expect(menuBox[0].left).toBeGreaterThan(selectedRow[0].right);

      const overlaps = (first: Box, second: Box) =>
        first.left < second.right &&
        first.right > second.left &&
        first.top < second.bottom &&
        first.bottom > second.top;
      expect(overlaps(menuBox[0], selectedRow[0])).toBe(false);
      expect(overlaps(menuBox[0], selectedIdentity[0])).toBe(false);
      expect(overlaps(menuBox[0], relationship[0])).toBe(false);
      await expect(page.getByTestId("relationship-action")).toBeVisible();

      await page.reload();
      await awaitProductFont(page);
      await page
        .getByRole("button", { name: `Actions for ${fixture.memberName}` })
        .click();
      await expect(page.getByTestId("circle-member-actions-menu")).toBeVisible();
      expect(browserErrors).toEqual([]);

      const evidenceDir = process.env.OVERFLOW_ACTION_EVIDENCE_DIR;
      if (evidenceDir) {
        fs.mkdirSync(evidenceDir, { recursive: true });
        await page.screenshot({
          path: path.join(
            evidenceDir,
            `circle-overflow-actions-${testInfo.project.name}.png`,
          ),
          fullPage: true,
        });
      }
    } finally {
      await fixture.close();
    }
  });

  test("opens the production phone sheet with member context", async ({
    page,
  }, testInfo) => {
    const fixture = await startProductionMemberActionsFixture();
    const browserErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") browserErrors.push(message.text());
    });
    page.on("pageerror", (error) => browserErrors.push(error.message));

    try {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(fixture.url);
      await awaitProductFont(page);

      await page
        .getByRole("button", { name: `Actions for ${fixture.memberName}` })
        .click();

      const sheet = page.getByTestId("circle-member-actions-sheet");
      await expect(sheet).toBeVisible();
      await sheet.evaluate(async (element) => {
        await Promise.all(
          element.getAnimations().map((animation) => animation.finished),
        );
      });
      await expect(sheet).toContainText(fixture.memberName);
      await expect(
        page.getByRole("menu", { name: `Actions for ${fixture.memberName}` }),
      ).toBeVisible();
      await expect(
        page.getByRole("menuitem", { name: "Share location" }),
      ).toBeVisible();
      await expect(
        page.getByRole("menuitem", { name: "Remove from Circle" }),
      ).toBeVisible();

      const sheetBox = (
        await boxesOf(page, '[data-testid="circle-member-actions-sheet"]')
      )[0];
      expect(sheetBox.left).toBe(0);
      expect(sheetBox.right).toBe(390);
      // Vaul deliberately extends the draggable sheet below the viewport so
      // an overscroll cannot expose the page behind it. What matters to the
      // person is that the visible surface covers the bottom edge completely.
      expect(sheetBox.top).toBeGreaterThan(0);
      expect(sheetBox.top).toBeLessThan(844);
      expect(sheetBox.bottom).toBeGreaterThanOrEqual(844);

      await page.reload();
      await awaitProductFont(page);
      await page
        .getByRole("button", { name: `Actions for ${fixture.memberName}` })
        .click();
      await expect(page.getByTestId("circle-member-actions-sheet")).toBeVisible();
      expect(browserErrors).toEqual([]);

      const evidenceDir = process.env.OVERFLOW_ACTION_EVIDENCE_DIR;
      if (evidenceDir) {
        fs.mkdirSync(evidenceDir, { recursive: true });
        await page.screenshot({
          path: path.join(
            evidenceDir,
            `circle-overflow-actions-sheet-${testInfo.project.name}.png`,
          ),
          fullPage: true,
        });
      }
    } finally {
      await fixture.close();
    }
  });

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

    // The old wrapping layout also made row heights inconsistent without
    // aligning the trailing columns; the stagger above is the regression's
    // essential geometry.
    expect(
      spread(rows.map(contentHeight)),
      "the shipped row heights",
    ).toBeGreaterThan(4);
  });
});

test.describe("Circle detail responsive layout", () => {
  for (const width of WIDTHS) {
    test(`keeps Leave circle responsive and trailing-aligned at ${width}px`, async ({
      page,
    }, testInfo) => {
      const leaveClass = cn(
        buttonVariants({ variant: "ghost", size: "default" }),
        CARD_SURFACE,
        CIRCLE_LEAVE_ACTION_CLASSNAME,
      );
      const body = `<main data-flow style="max-width:700px;margin:32px auto">
  <header style="margin-bottom:20px"><h1 class="ui-text-page-title">Business</h1><p style="color:var(--app-secondary-label)">5 people</p></header>
  <section data-members style="border-radius:24px;background:var(--app-card-surface-default-solid);overflow:hidden">
    <div style="min-height:72px;padding:16px;color:var(--app-primary-label)">Manish Sainani · Owner</div>
    <div style="min-height:72px;padding:16px;border-top:1px solid var(--app-separator);color:var(--app-primary-label)">Jhumma Kumari · Connected</div>
    <div style="min-height:72px;padding:16px;border-top:1px solid var(--app-separator);color:var(--app-primary-label)">Neelesh Meena · You</div>
  </section>
  <div data-leave-row style="display:flex;justify-content:flex-end;margin-top:20px">
    <button data-leave class="${leaveClass}">
      <svg data-leave-icon aria-hidden="true" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 5H5v14h4M14 8l4 4-4 4M8 12h10"/></svg>
      <span>Leave circle</span>
    </button>
  </div>
</main>`;
      await page.setViewportSize({ width, height: 844 });
      await page.goto(await buildFixture("circle-leave-action", body, CANDIDATES));

      const [flow, members, leave] = await Promise.all([
        boxesOf(page, "[data-flow]"),
        boxesOf(page, "[data-members]"),
        boxesOf(page, "[data-leave]"),
      ]);

      expect(leave[0].top).toBeGreaterThanOrEqual(members[0].bottom);
      expect(Math.abs(leave[0].right - flow[0].right)).toBeLessThanOrEqual(1);
      expect(leave[0].width).toBeLessThanOrEqual(320);
      expect(leave[0].height).toBe(44);
      await expect(page.locator("[data-leave-icon]")).toHaveCSS(
        "fill",
        "none",
      );

      const evidenceDir = process.env.CIRCLE_LEAVE_EVIDENCE_DIR;
      if (evidenceDir && (width === 393 || width === 1440)) {
        fs.mkdirSync(evidenceDir, { recursive: true });
        await page.screenshot({
          path: path.join(
            evidenceDir,
            `circle-leave-${width}-${testInfo.project.name}.png`,
          ),
          fullPage: true,
        });
      }
    });
  }

  for (const width of WIDTHS) {
    test(`places Proceed to SMS after the roster and against its right edge at ${width}px`, async ({
      page,
    }) => {
      const proceedClass = cn(
        buttonVariants({ variant: "default", size: "default" }),
        CIRCLE_PROCEED_TO_SMS_CLASSNAME,
      );
      const body = `<main data-flow style="max-width:960px;margin:32px auto">
  <section data-members>
    <div style="margin-bottom:10px;color:var(--app-secondary-label);font-size:14px;font-weight:600">Members</div>
    <div style="border-radius:24px;background:var(--app-card-surface-default-solid);overflow:hidden">
      <div style="min-height:72px;padding:16px;color:var(--app-primary-label)">Jhumma Kumari</div>
      <div style="min-height:72px;padding:16px;border-top:1px solid var(--app-separator);color:var(--app-primary-label)">Neelesh Meena</div>
      <div style="min-height:72px;padding:16px;border-top:1px solid var(--app-separator);color:var(--app-primary-label)">Rashid</div>
    </div>
  </section>
  <div data-proceed-row style="display:flex;justify-content:flex-end;margin-top:20px">
    <button data-proceed class="${proceedClass}">Proceed to SMS</button>
  </div>
</main>`;
      await page.setViewportSize({ width, height: 844 });
      await page.goto(
        await buildFixture("circle-proceed-to-sms", body, CANDIDATES),
      );

      const [flow, members, proceed] = await Promise.all([
        boxesOf(page, "[data-flow]"),
        boxesOf(page, "[data-members]"),
        boxesOf(page, "[data-proceed]"),
      ]);

      expect(proceed[0].top).toBeGreaterThanOrEqual(members[0].bottom);
      expect(Math.abs(proceed[0].right - flow[0].right)).toBeLessThanOrEqual(1);
      expect(proceed[0].width).toBeLessThanOrEqual(320);
      expect(proceed[0].height).toBe(48);

      const evidenceDir = process.env.CIRCLE_CTA_EVIDENCE_DIR;
      if (evidenceDir && (width === 393 || width === 1440)) {
        fs.mkdirSync(evidenceDir, { recursive: true });
        await page.screenshot({
          path: path.join(evidenceDir, `circle-cta-${width}.png`),
          fullPage: true,
        });
      }
    });
  }

  for (const width of WIDTHS) {
    test(`keeps the complete Circle title and Edit action visible at ${width}px`, async ({
      page,
    }) => {
      const body = `<div data-detail-header class="${CIRCLE_DETAIL_HEADER_CLASSNAME}">
  <div class="${CIRCLE_DETAIL_HEADER_COPY_CLASSNAME}">
    <header><h1 data-circle-title class="ui-text-page-title">Trusted Family and Emergency Circle Featherstonehaugh-Rajendran</h1></header>
  </div>
  <button data-edit class="h-11 shrink-0 rounded-full px-4">Edit</button>
</div>`;
      await page.setViewportSize({ width, height: 844 });
      await page.goto(
        await buildFixture("circle-detail-title", body, [
          ...CANDIDATES,
          "h-11",
          "shrink-0",
          "px-4",
        ]),
      );
      await awaitProductFont(page);

      const result = await page.evaluate(() => {
        const title = document.querySelector<HTMLElement>(
          "[data-circle-title]",
        )!;
        const edit = document.querySelector<HTMLElement>("[data-edit]")!;
        const header = document.querySelector<HTMLElement>(
          "[data-detail-header]",
        )!;
        const style = getComputedStyle(title);
        return {
          titleClientWidth: title.clientWidth,
          titleScrollWidth: title.scrollWidth,
          titleOverflowY: style.overflowY,
          copyOverflowY: getComputedStyle(title.parentElement!.parentElement!).overflowY,
          textOverflow: style.textOverflow,
          whiteSpace: style.whiteSpace,
          editRight: edit.getBoundingClientRect().right,
          headerRight: header.getBoundingClientRect().right,
          pageScrollWidth: document.documentElement.scrollWidth,
          viewportWidth: window.innerWidth,
        };
      });

      expect(result.titleScrollWidth).toBeLessThanOrEqual(
        result.titleClientWidth + 1,
      );
      // DM Sans glyphs extend beyond the line box by a few pixels; scrollHeight
      // counts that visible ink even when nothing clips it. Check the actual
      // clipping and viewport conditions instead.
      expect(result.titleOverflowY).toBe("visible");
      expect(result.copyOverflowY).toBe("visible");
      expect(result.pageScrollWidth).toBeLessThanOrEqual(result.viewportWidth + 1);
      expect(result.textOverflow).not.toBe("ellipsis");
      expect(result.whiteSpace).not.toBe("nowrap");
      expect(result.editRight).toBeLessThanOrEqual(result.headerRight + 1);
    });

    test(`uses a single phone scroller for the Circle roster at ${width}px`, async ({
      page,
    }) => {
      const body = `<div data-roster-shell class="${CIRCLE_MEMBERS_CARD_SHELL_CLASSNAME}">
  <div data-roster-scroll class="${CIRCLE_MEMBERS_CARD_SCROLL_CLASSNAME}">
    <div style="height: 1200px">Members</div>
  </div>
</div>`;
      await page.setViewportSize({ width, height: 844 });
      await page.goto(
        await buildFixture("circle-roster-scroll", body, CANDIDATES),
      );
      await awaitProductFont(page);

      const result = await page.evaluate(() => {
        const shell = document.querySelector<HTMLElement>(
          "[data-roster-shell]",
        )!;
        const scroll = document.querySelector<HTMLElement>(
          "[data-roster-scroll]",
        )!;
        return {
          maxHeight: getComputedStyle(shell).maxHeight,
          overflowY: getComputedStyle(scroll).overflowY,
        };
      });

      if (width < 640) {
        expect(result.maxHeight).toBe("none");
        expect(result.overflowY).toBe("visible");
      } else {
        expect(result.maxHeight).not.toBe("none");
        expect(result.overflowY).toBe("auto");
      }
    });
  }
});
