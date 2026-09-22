import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  awaitProductFont,
  productFontStyle,
  stripAppFontFaces,
} from "./fixtures/product-font";

/**
 * One Live Voice's dock, measured without signing in or starting a microphone.
 *
 * The real surface is behind an authenticated session and a live relay.  A
 * browser test that visits that route anonymously would test the welcome
 * screen, and a test that starts a real microphone/socket would make this PR
 * gate slow and credential-dependent.  This fixture instead renders the
 * source-owned dock classes, labels and selectors from the shipped modules in
 * a real Tailwind cascade over file://.  If the panel cap, dock geometry, or
 * labelled Minimize/Expand control moves in product source, extraction fails
 * loudly rather than silently measuring a stale replica.
 *
 * The sibling React tests own session semantics (including that minimizing
 * does not call session.stop).  This contract owns the browser-only facts:
 * narrow-screen geometry, touch targets, distinct controls, and the visible
 * minimize/restore path.
 *
 * Run with: npm run test:one-voice-panel-layout
 */

const WEBAPP_ROOT = process.cwd();
const VOICE_PILL_PATH = "components/one-voice/voice-state-pill.tsx";
const VOICE_PANEL_PATH = "components/one-voice/one-voice-panel.tsx";
const VOICE_CONTROL_PATH = "components/one-voice/one-voice-control.tsx";

const VIEWPORTS = [
  { name: "narrow phone", width: 320, height: 568 },
  { name: "standard phone", width: 390, height: 844 },
  { name: "tablet", width: 768, height: 1024 },
] as const;

const MIN_TOUCH_TARGET_PX = 44;
const PANEL_VIEWPORT_SHARE = 0.52;
const PANEL_MAX_HEIGHT_PX = 420;
const BOUNDARY_TOLERANCE_PX = 1;

function read(relativePath: string): string {
  return fs.readFileSync(path.join(WEBAPP_ROOT, relativePath), "utf8");
}

function required(
  source: string,
  pattern: RegExp,
  description: string,
  relativePath: string,
): RegExpMatchArray {
  const match = source.match(pattern);
  if (match) return match;
  throw new Error(
    `one-voice-panel-layout: could not extract ${description} from ${relativePath}. ` +
      "Update this source-coupled fixture with the shipped markup instead of copying it.",
  );
}

function stringConstant(
  source: string,
  name: string,
  relativePath: string,
): string {
  return required(
    source,
    new RegExp(`const\\s+${name}\\s*=\\s*\\n?\\s*"([^"]+)";`),
    `${name} class constant`,
    relativePath,
  )[1];
}

type Source = {
  panelClass: string;
  clearButtonClass: string;
  dockClass: string;
  dockWidthClass: string;
  primaryClass: string;
  iconButtonClass: string;
  toggleButtonClass: string;
  toggleIconClass: string;
  minimizeAriaLabel: string;
  expandAriaLabel: string;
  minimizeLabel: string;
  expandLabel: string;
};

function extractSource(): Source {
  const pill = read(VOICE_PILL_PATH);
  const panel = read(VOICE_PANEL_PATH);
  const control = read(VOICE_CONTROL_PATH);
  const toggleStart = pill.indexOf('data-testid="one-voice-toggle-panel"');
  const toggleEnd = pill.indexOf("</button>", toggleStart);
  if (toggleStart < 0 || toggleEnd < toggleStart) {
    throw new Error(
      "one-voice-panel-layout: could not isolate one-voice-toggle-panel in voice-state-pill.tsx.",
    );
  }
  const toggle = pill.slice(toggleStart, toggleEnd);

  const labels = required(
    toggle,
    /<span>\{expanded \? "([^"]+)" : "([^"]+)"\}<\/span>/,
    "visible Minimize/Expand labels",
    VOICE_PILL_PATH,
  );
  const aria = required(
    toggle,
    /aria-label=\{expanded \? "([^"]+)" : "([^"]+)"\}/,
    "Minimize/Expand accessible names",
    VOICE_PILL_PATH,
  );
  const icons = [...toggle.matchAll(/className="([^"]+)" aria-hidden/g)];
  if (icons.length !== 2 || icons[0][1] !== icons[1][1]) {
    throw new Error(
      "one-voice-panel-layout: expected matching source-owned minimize and expand icon classes.",
    );
  }

  const source = {
    panelClass: required(
      panel,
      /data-testid="one-voice-panel"[\s\S]*?className=\{cn\(\s*"([^"]+)"/,
      "One Voice panel classes",
      VOICE_PANEL_PATH,
    )[1],
    clearButtonClass: stringConstant(
      panel,
      "CLEAR_ACTION_BUTTON",
      VOICE_PANEL_PATH,
    ),
    dockClass: required(
      control,
      /<div\s+data-testid="one-voice-agent-bar"[\s\S]*?className=\{cn\(\s*"([^"]+)"/,
      "One Voice dock classes",
      VOICE_CONTROL_PATH,
    )[1],
    dockWidthClass: stringConstant(control, "DOCK_WIDTH_SLOT", VOICE_CONTROL_PATH),
    primaryClass: required(
      pill,
      /data-testid="one-voice-agent-bar-start-icon"[\s\S]*?className="([^"]+)"/,
      "voice activity button classes",
      VOICE_PILL_PATH,
    )[1],
    iconButtonClass: stringConstant(pill, "ICON_BUTTON", VOICE_PILL_PATH),
    toggleButtonClass: stringConstant(
      pill,
      "PANEL_TOGGLE_BUTTON",
      VOICE_PILL_PATH,
    ),
    toggleIconClass: icons[0][1],
    minimizeAriaLabel: aria[1],
    expandAriaLabel: aria[2],
    minimizeLabel: labels[1],
    expandLabel: labels[2],
  };

  // These are product requirements, not fixture wording.  A shorter label can
  // fit while again making the presentation-only action ambiguous beside Stop.
  if (source.minimizeLabel !== "Minimize" || source.expandLabel !== "Expand") {
    throw new Error(
      `one-voice-panel-layout: expected visible Minimize/Expand copy, found "${source.minimizeLabel}"/"${source.expandLabel}".`,
    );
  }
  if (!source.panelClass.includes("max-h-[min(52dvh,420px)]")) {
    throw new Error(
      "one-voice-panel-layout: the shipped panel no longer declares its min(52dvh,420px) bound.",
    );
  }
  return source;
}

const SOURCE = extractSource();

const FIXTURE_CLASSES = [
  "flex flex-col items-center gap-2",
  "h-6 min-w-6 flex-1 rounded-full bg-[color:var(--app-neutral-fill)]",
  "flex min-w-0 flex-col leading-tight",
  "truncate text-[13px] font-medium",
  "space-y-3 text-sm leading-6",
  "min-w-0 break-words",
  // The panel toolbar row that carries the Clear chat view control.
  "flex min-h-11 items-center justify-between gap-2 text-[12px]",
].join(" ");

let fixtureUrl: Promise<string> | null = null;

async function buildFixture(): Promise<string> {
  if (fixtureUrl) return fixtureUrl;
  fixtureUrl = (async () => {
    const { compile } = (await import(
      path.join(WEBAPP_ROOT, "node_modules/tailwindcss/dist/lib.mjs"),
    )) as {
      compile: (
        css: string,
        options: unknown,
      ) => Promise<{ build: (candidates: string[]) => string }>;
    };
    const globals = fs
      .readFileSync(path.join(WEBAPP_ROOT, "app/globals.css"), "utf8")
      .replace(/^@source\s+[^;]+;\s*$/gm, "");
    const compiler = await compile(globals, {
      base: path.join(WEBAPP_ROOT, "app"),
      onDependency: () => {},
      loadStylesheet: async (id: string, base: string) => {
        const file =
          id === "tailwindcss"
            ? path.join(WEBAPP_ROOT, "node_modules/tailwindcss/index.css")
            : id === "tw-animate-css"
              ? path.join(
                  WEBAPP_ROOT,
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

    const candidates = new Set(
      [
        SOURCE.panelClass,
        SOURCE.dockClass,
        SOURCE.dockWidthClass,
        SOURCE.primaryClass,
        SOURCE.iconButtonClass,
        SOURCE.toggleButtonClass,
        SOURCE.toggleIconClass,
        SOURCE.clearButtonClass,
        FIXTURE_CLASSES,
      ]
        .join(" ")
        .split(/\s+/)
        .filter(Boolean),
    );
    const css = stripAppFontFaces(compiler.build([...candidates]));
    const transcript = Array.from(
      { length: 28 },
      (_, index) =>
        `<p class="min-w-0 break-words">One: A complete transcript line ${index + 1} stays available when the panel is restored.</p>`,
    ).join("");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "one-voice-panel-"));
    fs.writeFileSync(path.join(dir, "fixture.css"), css);
    fs.writeFileSync(
      path.join(dir, "fixture.html"),
      `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${productFontStyle()}</style><link rel="stylesheet" href="fixture.css">
<style>
html, body { height: 100%; margin: 0; overflow-x: hidden; }
#fixture-root { position: fixed; inset-inline: 12px; bottom: 12px; z-index: 1; }
/* Layout is sampled after the panel has entered. Its production animation
   translates the first few frames, which is not an overlap and would make a
   geometry assertion depend on precisely when a runner takes its snapshot. */
.one-voice-panel-enter { animation: none !important; transform: none !important; }
</style></head><body><div id="fixture-root"></div>
<script>
const source = ${JSON.stringify(SOURCE)};
const transcript = ${JSON.stringify(transcript)};
const root = document.getElementById("fixture-root");
let stopCalls = 0;
function render(expanded) {
  const toolbar = '<div data-testid="one-voice-panel-toolbar" class="flex min-h-11 items-center justify-between gap-2"><p data-testid="one-voice-clear-status" class="text-[12px]"></p><button type="button" data-testid="one-voice-clear-history" aria-label="Clear chat view" class="' + source.clearButtonClass + '">Clear chat view</button></div>';
  const panel = expanded ? '<section role="region" aria-label="One conversation" data-testid="one-voice-panel" class="' + source.panelClass + '">' + toolbar + '<div data-testid="one-voice-transcript" class="space-y-3 text-sm leading-6">' + transcript + '</div></section>' : '';
  const toggleLabel = expanded ? source.minimizeLabel : source.expandLabel;
  const toggleAria = expanded ? source.minimizeAriaLabel : source.expandAriaLabel;
  root.innerHTML = '<div data-testid="fixture-one-voice-stack" class="flex flex-col items-center gap-2">' + panel +
    '<div data-testid="one-voice-agent-bar" data-voice-panel="' + (expanded ? 'open' : 'collapsed') + '" data-stop-calls="' + stopCalls + '" role="group" aria-label="One private agent" class="' + source.dockClass + ' ' + source.dockWidthClass + '">' +
      '<button type="button" data-testid="one-voice-agent-bar-start-icon" aria-label="Voice activity: Listening" class="' + source.primaryClass + '"><span aria-hidden="true" class="h-6 min-w-6 flex-1 rounded-full bg-[color:var(--app-neutral-fill)]"></span><span class="flex min-w-0 flex-col leading-tight"><span class="truncate text-[13px] font-medium">Listening</span>' + (!expanded ? '<span data-testid="one-voice-status-line">One: A complete transcript line stays available.</span>' : '') + '</span></button>' +
      '<button type="button" data-testid="one-voice-mute" aria-label="Mute microphone" class="' + source.iconButtonClass + '"><span aria-hidden="true"></span></button>' +
      '<button type="button" data-testid="one-voice-toggle-panel" aria-label="' + toggleAria + '" aria-expanded="' + expanded + '" class="' + source.toggleButtonClass + '"><span aria-hidden="true" data-icon="' + (expanded ? 'minimize' : 'maximize') + '" class="' + source.toggleIconClass + '"></span><span>' + toggleLabel + '</span></button>' +
      '<button type="button" data-testid="one-voice-stop" aria-label="Stop" class="' + source.iconButtonClass + ' rounded-r-full"><span aria-hidden="true"></span></button>' +
    '</div></div>';
  root.querySelector('[data-testid="one-voice-toggle-panel"]').addEventListener("click", () => render(!expanded));
  root.querySelector('[data-testid="one-voice-stop"]').addEventListener("click", () => {
    stopCalls += 1;
    root.querySelector('[data-testid="one-voice-agent-bar"]').setAttribute("data-stop-calls", String(stopCalls));
  });
}
render(true);
</script></body></html>`,
    );
    return `file://${path.join(dir, "fixture.html")}`;
  })();
  return fixtureUrl;
}

async function openFixture(page: Page, width: number, height: number) {
  await page.setViewportSize({ width, height });
  await page.goto(await buildFixture());
  await awaitProductFont(page);
}

type Rect = {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
};

type Geometry = {
  overflowX: number;
  panel: Rect | null;
  dock: Rect;
  toggle: Rect;
  stop: Rect;
  panelScrollHeight: number | null;
  panelOverflowY: string | null;
};

async function geometry(page: Page): Promise<Geometry> {
  return page.evaluate(() => {
    const get = (testId: string) =>
      document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
    const panel = get("one-voice-panel");
    const dock = get("one-voice-agent-bar");
    const toggle = get("one-voice-toggle-panel");
    const stop = get("one-voice-stop");
    if (!dock || !toggle || !stop) throw new Error("voice dock fixture is incomplete");
    const rect = (element: HTMLElement): Rect => {
      const box = element.getBoundingClientRect();
      return {
        left: box.left,
        right: box.right,
        top: box.top,
        bottom: box.bottom,
        width: box.width,
        height: box.height,
      };
    };
    return {
      overflowX: Math.max(
        document.documentElement.scrollWidth,
        document.body.scrollWidth,
      ) - document.documentElement.clientWidth,
      panel: panel ? rect(panel) : null,
      dock: rect(dock),
      toggle: rect(toggle),
      stop: rect(stop),
      panelScrollHeight: panel?.scrollHeight ?? null,
      panelOverflowY: panel ? getComputedStyle(panel).overflowY : null,
    };
  });
}

test.describe("One Live Voice panel minimization layout", () => {
  for (const viewport of VIEWPORTS) {
    test(`${viewport.name}: bounded, non-overlapping dock minimizes and restores`, async ({
      page,
    }, testInfo) => {
      await openFixture(page, viewport.width, viewport.height);

      const panel = page.getByTestId("one-voice-panel");
      const dock = page.getByTestId("one-voice-agent-bar");
      const toggle = page.getByTestId("one-voice-toggle-panel");
      const stop = page.getByTestId("one-voice-stop");
      await expect(panel).toBeVisible();
      await expect(toggle).toHaveAccessibleName(SOURCE.minimizeAriaLabel);
      await expect(toggle).toHaveText(SOURCE.minimizeLabel);
      await expect(toggle).toHaveAttribute("aria-expanded", "true");

      const open = await geometry(page);
      const panelCap = Math.min(
        viewport.height * PANEL_VIEWPORT_SHARE,
        PANEL_MAX_HEIGHT_PX,
      );
      expect(open.overflowX).toBeLessThanOrEqual(BOUNDARY_TOLERANCE_PX);
      expect(open.panel).not.toBeNull();
      if (!open.panel || open.panelScrollHeight === null) throw new Error("panel missing");
      expect(open.panel.height).toBeLessThanOrEqual(
        panelCap + BOUNDARY_TOLERANCE_PX,
      );
      // The fixture deliberately overfills the transcript: a panel shorter
      // than the content proves the max-height and internal scroll are real.
      expect(open.panel.height).toBeGreaterThanOrEqual(
        panelCap - 2,
      );
      expect(open.panelScrollHeight).toBeGreaterThan(open.panel.height + 2);
      expect(open.panelOverflowY).toMatch(/auto|scroll/);
      expect(open.panel.left).toBeGreaterThanOrEqual(-BOUNDARY_TOLERANCE_PX);
      expect(open.panel.right).toBeLessThanOrEqual(
        viewport.width + BOUNDARY_TOLERANCE_PX,
      );
      expect(open.panel.top).toBeGreaterThanOrEqual(-BOUNDARY_TOLERANCE_PX);
      // The panel belongs above, not on top of, the persistent controls.
      expect(open.panel.bottom).toBeLessThanOrEqual(
        open.dock.top - 7,
      );

      for (const control of [open.toggle, open.stop]) {
        expect(control.width).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
        expect(control.height).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
        expect(control.left).toBeGreaterThanOrEqual(
          open.dock.left - BOUNDARY_TOLERANCE_PX,
        );
        expect(control.right).toBeLessThanOrEqual(
          open.dock.right + BOUNDARY_TOLERANCE_PX,
        );
      }
      // Adjacent is fine; sharing physical pixels is not. The old chevron and
      // X were easy to confuse, so this keeps their hit regions distinct.
      expect(open.toggle.right).toBeLessThanOrEqual(
        open.stop.left + BOUNDARY_TOLERANCE_PX,
      );

      // The Clear chat view control lives in the panel header. It must meet
      // the same 44px floor as the dock controls and stay inside the panel's
      // bounds at every supported width, or it is unusable on a phone.
      const clear = page.getByTestId("one-voice-clear-history");
      await expect(clear).toBeVisible();
      await expect(clear).toHaveAccessibleName("Clear chat view");
      const clearBox = await clear.boundingBox();
      if (!clearBox) throw new Error("clear control missing");
      expect(clearBox.height).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
      expect(clearBox.width).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
      expect(clearBox.x).toBeGreaterThanOrEqual(
        open.panel.left - BOUNDARY_TOLERANCE_PX,
      );
      expect(clearBox.x + clearBox.width).toBeLessThanOrEqual(
        open.panel.right + BOUNDARY_TOLERANCE_PX,
      );
      // It is a view control, so it must never sit in the dock beside Stop.
      expect(clearBox.y + clearBox.height).toBeLessThanOrEqual(
        open.dock.top + BOUNDARY_TOLERANCE_PX,
      );
      await page.screenshot({
        path: testInfo.outputPath(`one-voice-clear-${viewport.name}-before.png`),
      });

      await toggle.click();
      await expect(panel).toHaveCount(0);
      // Minimizing takes the panel's own controls with it: no orphaned Clear
      // button may keep intercepting taps over the page.
      await expect(clear).toHaveCount(0);
      await page.screenshot({
        path: testInfo.outputPath(`one-voice-clear-${viewport.name}-after.png`),
      });
      await expect(dock).toHaveAttribute("data-voice-panel", "collapsed");
      await expect(toggle).toHaveAccessibleName(SOURCE.expandAriaLabel);
      await expect(toggle).toHaveText(SOURCE.expandLabel);
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await expect(page.getByTestId("one-voice-status-line")).toContainText(
        "transcript line",
      );

      const collapsed = await geometry(page);
      expect(collapsed.overflowX).toBeLessThanOrEqual(BOUNDARY_TOLERANCE_PX);
      expect(collapsed.dock.left).toBeGreaterThanOrEqual(-BOUNDARY_TOLERANCE_PX);
      expect(collapsed.dock.right).toBeLessThanOrEqual(
        viewport.width + BOUNDARY_TOLERANCE_PX,
      );

      await toggle.click();
      await expect(panel).toBeVisible();
      await expect(panel).toContainText("complete transcript line 28");
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      await expect(toggle).toHaveText(SOURCE.minimizeLabel);

      // Stop stays an independently hittable terminal action. It is clicked
      // only after restore so it cannot be mistaken for the panel toggle.
      await stop.click();
      await expect(dock).toHaveAttribute("data-stop-calls", "1");
    });
  }
});
