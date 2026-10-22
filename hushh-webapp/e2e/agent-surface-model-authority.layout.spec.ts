import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { awaitProductFont, productFontStyle } from "./fixtures/product-font";

// Relative, not "@/": the e2e tsconfig deliberately carries no path aliases.
import {
  AGENT_SURFACE_SOURCE as SRC,
  evaluateShippedExpression,
} from "./fixtures/agent-surface-source";

/**
 * Which agent is answering, measured on a real screen.
 *
 * Reported, and confirmed: switching Agent Chat to Puppy left ONE's own model
 * picker in the header, showing a cloud model such as "Gemini 3.5 Flash",
 * directly above a Puppy conversation whose model runs on the owner's Mac. Two
 * model pickers, on one screen, disagreeing about where the answer comes from.
 * On the one tier whose entire claim is where an answer was generated
 * (`docs/reference/ai/puppy-one-on-device.md`), that is the highest-order
 * defect there is. The trigger was gated only on
 * `modelPreference && modelPreference.choices.length > 1`, with no mode guard,
 * while the transcript and composer below it were correctly gated.
 *
 * WHY THIS IS A FIXTURE AND NOT A VISIT TO /one
 * ---------------------------------------------
 * `/one` and `/one/puppy` sit behind One's sign-in. A spec that navigates
 * there without reviewer credentials measures the welcome screen and passes
 * for the wrong reason forever. `AgentChatWorkspace` itself is 6,200 lines
 * wired to Firebase auth, the vault and the AG-UI stream, so it cannot be
 * mounted standalone either.
 *
 * So this follows `gemini-endpoint-fields.layout.spec.ts`: a standalone
 * fixture COMPILED FROM THE SHIPPED MODULE, measured in a real browser. Every
 * class string, every piece of copy and, crucially, the two conditional
 * expressions that decide whether One's picker renders are extracted from
 * `agent-chat-workspace.tsx` by `e2e/fixtures/agent-surface-source.ts` and
 * EXECUTED here with `isPuppySurface` bound. Delete the guard, invert it, or
 * reorder the actions around it, and the fixture's screen changes with the
 * product's. A stale copy of any of it fails at build time, loudly, by name.
 *
 * WHY A NAIVE VERSION OF THIS TEST WOULD LIE
 * ------------------------------------------
 *   - Asserting only "no element with the picker's testid" would pass against
 *     a header that still SHOWS a cloud model somewhere else. The check here
 *     is the symptom, not the selector: no cloud model name may reach the
 *     reader in Puppy mode, by visible text, `title` or accessible name.
 *   - Asserting only "the picker is gone" would pass against a fix that drops
 *     the toggle's anchor with it, sliding the mode toggle sideways under the
 *     thumb that just pressed it. The toggle's own edge is measured across the
 *     switch, at six widths.
 *   - Asserting "One's composer is not visible" with a DOM query would pass
 *     against a fix that UNMOUNTS it, destroying a cloud turn in flight. Both
 *     halves are pinned: out of the accessibility tree, still in the document.
 *   - A test that only ever sees the fixed code cannot say it would have caught
 *     anything. The last case renders the ungated header the defect shipped as
 *     and proves every check above fires on it.
 *
 * WHAT THIS CANNOT PROVE (deliberately not faked here)
 * ----------------------------------------------------
 *   - Real component behaviour: React state, `enterPuppySurface`'s voice stop,
 *     Radix Select internals, the segmented control's arrow-key roving
 *     tabindex, and where focus lands after a mode change. None of that is in
 *     the fixture, so none of it is asserted. The arrow-key contract is covered
 *     by `__tests__/components/segmented-control-a11y.test.tsx`, and the source
 *     shape by `__tests__/components/agent-chat-shell.contract.test.ts`.
 *   - That the two agents keep separate transcripts and histories end to end.
 *     That needs a signed-in session against a live pod.
 *
 * Run: npx playwright test e2e/agent-surface-model-authority.layout.spec.ts --project=chromium
 */

const WIDTHS = [320, 360, 390, 430, 768, 1024, 1280] as const;

/** A person with a choice of cloud models, so One's picker exists at all. */
const MODEL_PREFERENCE = {
  effective_model: "gemini-3.5-flash",
  choices: [
    { model_id: "gemini-3.5-flash", label: "Gemini 3.5 Flash" },
    { model_id: "gemini-3.5-pro", label: "Gemini 3.5 Pro" },
  ],
};

/** The model Puppy One reports, which is a local weight file, not a Gemini. */
const PUPPY_MODEL = "qwen3-30b-a3b-mlx";

/**
 * The vendor word every cloud choice above shares. It is what a reader would
 * recognise as "this answer is coming from somewhere else", and finding it
 * anywhere on the Puppy screen is the defect regardless of which control put
 * it there.
 */
const CLOUD_VENDOR = /gemini/i;

type Mode = "one" | "puppy";

interface Variant {
  /** Render the empty-chat welcome using production layout classes. */
  welcomeName?: string;
  welcomeTheme?: "light" | "dark";
  /** Whether this person has more than one cloud model to choose between. */
  canPickOneModel: boolean;
  /**
   * `false` reproduces the header AS REPORTED: One's picker gated only on
   * `modelPreference && modelPreference.choices.length > 1`.
   *
   * That condition is retyped here on purpose, from the defect's own diff, and
   * is the only retyped condition in this file. It has to be: it no longer
   * exists in the shipped source to extract, and pinning the negative control
   * to today's header markup would make it fail for reasons that have nothing to
   * do with the defect it exists to reproduce.
   */
  applyShippedGate: boolean;
  /** Opt into the actual centered header CSS and NativeChatChrome wrappers. */
  centeredHeader?: boolean;
  stackedPhoneCss?: boolean;
  workingSubtitle?: string;
  safeTop?: number;
}

const SHIPPED: Variant = { canPickOneModel: true, applyShippedGate: true, centeredHeader: true };
const SINGLE_MODEL: Variant = {
  canPickOneModel: false,
  applyShippedGate: true,
  centeredHeader: true,
};
const AS_REPORTED: Variant = { canPickOneModel: true, applyShippedGate: false };

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * The shipped guards, executed for one mode. The only branch that does not run
 * shipped source is the `AS_REPORTED` one, which reproduces a condition that no
 * longer exists to extract; see `Variant.applyShippedGate`.
 */
function decide(mode: Mode, variant: Variant, width = 1024) {
  const scope = {
    isPuppySurface: mode === "puppy",
    oneDisplayName: "One",
    canPickOneModel: variant.canPickOneModel,
    modelPreference: MODEL_PREFERENCE,
    hasInlineModelPicker: width >= 640,
    nativeCompact: !variant.centeredHeader,
  };
  const showPicker = variant.applyShippedGate
    ? Boolean(evaluateShippedExpression(SRC.cloudPicker.gateExpression, scope))
    : MODEL_PREFERENCE.choices.length > 1;
  return {
    centered: evaluateShippedExpression(SRC.header.centeredMarkerExpression, scope) === "true",
    name: String(evaluateShippedExpression(SRC.header.nameExpression, scope)),
    subtitle: String(
      evaluateShippedExpression(SRC.header.subtitleExpression, scope),
    ),
    showPicker,
    oneHidden: String(
      evaluateShippedExpression(SRC.visibility.oneHiddenExpression, scope) ||
        "",
    ),
    puppyHidden: String(
      evaluateShippedExpression(SRC.visibility.puppyHiddenExpression, scope) ||
        "",
    ),
  };
}

function cloudChipLabel(): string {
  const choice = MODEL_PREFERENCE.choices.find(
    (candidate) => candidate.model_id === MODEL_PREFERENCE.effective_model,
  );
  const strip = new RegExp(
    SRC.cloudPicker.labelStrip.pattern,
    SRC.cloudPicker.labelStrip.flags,
  );
  return (choice?.label ?? MODEL_PREFERENCE.effective_model).replace(
    strip,
    SRC.cloudPicker.labelStrip.replacement,
  );
}

function cloudChipTitle(): string {
  return SRC.cloudPicker.titleTemplate.replace(
    "${modelPreference.effective_model}",
    MODEL_PREFERENCE.effective_model,
  );
}

function renderScreen(mode: Mode, variant: Variant, width: number): string {
  const plan = decide(mode, variant, width);

  const segments = SRC.toggle.options
    .map((option) => {
      const active = option.value === mode;
      return `<button type="button" role="radio" data-mode="${option.value}"
        aria-checked="${active}" aria-label="${escapeHtml(option.accessibleLabel ?? option.label)}"
        class="${SRC.toggle.segmentClass}${active ? " bg-background text-foreground shadow-sm" : " text-muted-foreground"}"
      >${option.icon ? `<svg aria-hidden="true" class="inline-block ${SRC.toggle.iconClass}" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor"/></svg>` : ""}<span class="${SRC.toggle.labelClass}">${escapeHtml(option.label)}</span></button>`;
    })
    .join("");

  const picker = plan.showPicker
    ? `<button type="button" role="combobox"
         data-testid="${SRC.cloudPicker.testId}"
         aria-label="${escapeHtml(SRC.cloudPicker.ariaLabel)}"
         title="${escapeHtml(cloudChipTitle())}"
         class="${SRC.cloudPicker.triggerClass} inline-flex items-center"
       ><svg aria-hidden="true" class="${SRC.cloudPicker.iconClass}" viewBox="0 0 24 24"><rect x="5" y="5" width="14" height="14" rx="2" fill="none" stroke="currentColor"/></svg><span class="truncate">${escapeHtml(cloudChipLabel())}</span></button>`
    : "";

  const toggleGroup = `<div role="radiogroup" data-testid="agent-toggle" aria-label="${escapeHtml(SRC.toggle.ariaLabel)}"
             class="${SRC.toggle.containerClass} w-auto shrink-0" style="min-width:${SRC.toggle.minimumWidth}px">${segments}</div>`;
  const framedToggle = `<div class="${SRC.toggle.frameClass}">${toggleGroup}</div>`;
  const toggle = variant.centeredHeader
    ? `<div class="${SRC.header.centered.surfaceClass}"><div>${framedToggle}</div></div>`
    : framedToggle;
  const profileButton = `<button type="button" data-testid="profile-open-button" aria-label="Open Profile"
             class="inline-flex shrink-0 items-center justify-center rounded-full ${SRC.header.profileClass}"><span data-testid="profile-photo" class="${SRC.header.profilePhotoClass}"></span></button>`;
  const profile = variant.centeredHeader
    ? `<span class="relative inline-flex shrink-0 overflow-visible align-middle">${profileButton}</span>`
    : profileButton;
  const artwork = SRC.header.centered.artwork;
  const artworkMarkup = `<div class="${artwork.containerClass}"><img data-testid="one-artwork" alt="" width="64" height="64" class="${artwork.className}"></div>`;
  const brand = mode === "one"
    ? `<span class="relative inline-flex shrink-0 overflow-visible align-middle"><button data-agent-chat-one-profile-trigger data-testid="one-profile-button" aria-label="Open One profile" class="inline-flex items-center justify-center rounded-full ${SRC.header.centered.profileTriggerClass}"><span class="inline-flex items-center justify-center">${artworkMarkup}</span></button></span>`
    : artworkMarkup;
  const subtitle = variant.workingSubtitle ?? plan.subtitle;
  // Rendered in the shipped source order, so the toggle's anchor is whatever
  // the product anchors it to.
  const actions = SRC.header.actionOrder
    .map((action) => ({ picker, toggle, profile })[action])
    .join("");

  const header = `
    <div data-testid="agent-header" data-agent-header-layout="${variant.centeredHeader ? "portrait" : "compact"}" ${plan.centered ? 'data-one-centered-header="true"' : ""} class="${SRC.header.containerClass}">
      <button type="button" data-testid="history-button" aria-label="Open chat history" class="${escapeHtml(SRC.header.historyClass)}"></button>
      <div data-agent-chat-header-region="identity" data-testid="agent-identity" class="${SRC.header.identityClass}">
        <div data-agent-chat-brand-tile data-testid="agent-brand-tile" class="${SRC.header.brandTileClass}">${brand}</div>
        <div class="min-w-0">
          <div data-testid="agent-name" class="${SRC.header.nameClass}">${escapeHtml(plan.name)}</div>
          ${subtitle ? `<p data-testid="agent-subtitle" class="${SRC.header.subtitleClass}"><span class="block truncate">${escapeHtml(subtitle)}</span></p>` : ""}
        </div>
      </div>
      <div data-agent-chat-header-region="actions" data-testid="agent-header-cluster" class="${SRC.header.clusterClass}">${actions}</div>
    </div>`;

  /*
   * Puppy One's surface. Only the two things this spec measures are modelled:
   * its own model control (the real `PuppyModelPicker` trigger's classes and
   * title, extracted) and its own composer. The picker reports a local weight
   * file, which is what makes the "no cloud model name on this screen" sweep
   * meaningful rather than tautological.
   */
  const puppySurface = `
    <section data-agent-surface="puppy" data-testid="puppy-surface"
             class="flex min-h-0 flex-1 flex-col overflow-hidden px-4 pb-3 pt-5 sm:px-6 ${plan.puppyHidden}">
      <div class="mx-auto flex min-h-0 w-full max-w-4xl flex-1 flex-col gap-3">
        <div class="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-border/60 bg-background">
          <div class="${SRC.puppy.panelHeaderClass}">
            <div class="${SRC.puppy.panelBodyClass}">
              <div class="${SRC.puppy.controlsClass}">
            <button type="button" class="${SRC.puppy.pickerClass} ${SRC.puppy.pickerInstanceClass}"
                    title="${escapeHtml(SRC.puppy.pickerTitle)}">${escapeHtml(PUPPY_MODEL)}</button>
            <button type="button" aria-pressed="true"
                    class="${SRC.puppy.pinOnClass}">${escapeHtml(SRC.puppy.pinOnLabel)}</button>
              </div>
            </div>
          </div>
          <div class="min-h-0 flex-1 overflow-y-auto px-4 py-4"></div>
          <div class="flex items-end gap-2 border-t border-border/60 px-4 py-3">
            <textarea rows="1" placeholder="${escapeHtml(SRC.puppy.composerPlaceholder)}"
              class="max-h-32 min-h-[2.5rem] flex-1 resize-none rounded-xl border border-border/70 bg-background px-3 py-2 text-sm"></textarea>
            <button type="button" aria-label="${escapeHtml(SRC.puppy.sendLabel)}" class="h-9 w-9 rounded-md border">&#8594;</button>
          </div>
        </div>
      </div>
    </section>`;

  /*
   * One's transcript and composer, hidden rather than unmounted, so a cloud
   * turn in flight survives a glance at Puppy. The spec asserts both halves.
   */
  const oneTranscript = variant.welcomeName !== undefined ? `
    <div class="${SRC.welcome.viewportClass} ${plan.oneHidden}">
      <div data-testid="one-transcript" class="${SRC.welcome.scrollClass}">
        <div class="${SRC.welcome.transcriptColumnClass}">
          <section data-testid="welcome" class="${SRC.welcome.sectionClass}">
            <div class="${SRC.welcome.columnClass}">
              <h2 data-testid="welcome-heading" class="${SRC.welcome.headingClass}">Hi ${escapeHtml(variant.welcomeName)}</h2>
              <p class="${SRC.welcome.descriptionClass}">What would you like to do today?</p>
            </div>
          </section>
        </div>
      </div>
    </div>` : `
    <div data-testid="one-transcript"
         class="min-h-0 flex-1 overflow-y-auto px-4 pt-5 pb-6 sm:px-6 ${plan.oneHidden}">
      <div class="mx-auto flex min-h-full w-full max-w-4xl flex-col gap-6">
        <p>Here is what I found in your calendar.</p>
      </div>
    </div>`;

  const oneComposer = `
    <form data-testid="one-composer" class="shrink-0 px-3 pt-3 pb-3 sm:px-5 ${plan.oneHidden}">
      <div class="mx-auto w-full max-w-4xl">
        <textarea rows="1" data-testid="${SRC.oneComposer.testId}"
          aria-label="${escapeHtml(SRC.oneComposer.ariaLabel)}"
          class="max-h-28 min-h-16 w-full resize-none rounded-[24px] bg-foreground/[0.045] px-7 py-3"></textarea>
      </div>
    </form>`;

  return `${header}${puppySurface}${oneTranscript}${oneComposer}`;
}

const TOKENS = `
  :root {
    --agent-chat-header-safe-top: 0px;
    --app-accent: #087ff5;
    --app-accent-soft: #e6f1fe;
    --app-accent-deep: #0a5fb8;
    --app-success-tint: #e6f6ea;
    --app-success-deep: #17803d;
    --background: #ffffff;
    --foreground: #101014;
  }
  body { margin: 0; background: var(--background); color: var(--foreground); }
  .text-foreground { color: var(--foreground); }
  .text-muted-foreground { color: #6b6b76; }
  .bg-background { background: var(--background); }
  .border-border\\/60, .border-border\\/70 { border-color: rgba(60,60,67,.16); }
  .bg-muted\\/80 { background: rgba(120,120,128,.12); }
  .bg-foreground\\/\\[0\\.045\\] { background: rgba(16,16,20,.045); }
  #screen { display: flex; flex-direction: column; height: 100vh; min-height: 0; }
`;

async function compileTailwind(candidates: Iterable<string>): Promise<string> {
  const webappRoot = process.cwd();
  const { compile } = (await import(
    path.join(webappRoot, "node_modules/tailwindcss/dist/lib.mjs")
  )) as {
    compile: (
      css: string,
      opts: unknown,
    ) => Promise<{ build: (candidates: string[]) => string }>;
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
  return compiler.build([...candidates]);
}

const fixtureCache = new Map<string, string>();

/**
 * One page holding both modes' markup, switched by the toggle, so the mode
 * change is a real re-render in a real layout rather than two screenshots of
 * two documents.
 */
async function buildFixture(variant: Variant, width: number): Promise<string> {
  const key = JSON.stringify([variant, width]);
  const cached = fixtureCache.get(key);
  if (cached) return cached;

  const screens: Record<Mode, string> = {
    one: renderScreen("one", variant, width),
    puppy: renderScreen("puppy", variant, width),
  };

  const used = new Set<string>();
  for (const markup of Object.values(screens)) {
    for (const match of markup.matchAll(/class="([^"]*)"/g)) {
      for (const token of match[1].split(/\s+/)) if (token) used.add(token);
    }
  }
  const css = await compileTailwind(used);
  const globals = fs.readFileSync(path.join(process.cwd(), "app/globals.css"), "utf8");
  const geometryStart = globals.indexOf("/* One shared header measure,");
  if (geometryStart < 0) throw new Error("Missing shared Chat header geometry");
  let geometry = globals.slice(geometryStart);
  if (variant.stackedPhoneCss) {
    // Historical negative control: identity and controls occupy separate rows.
    geometry += `@media (max-width:767px) {
      .agent-chat-header[data-one-centered-header="true"] { grid-template-columns:44px minmax(0,1fr); grid-template-rows:88px 44px; height:calc(152px + var(--agent-chat-header-safe-top)); }
      .agent-chat-header[data-one-centered-header="true"] [data-agent-chat-header-region="identity"] { position:static; transform:none; grid-column:1 / -1; grid-row:1; }
      .agent-chat-header[data-one-centered-header="true"] > :first-child, .agent-chat-header[data-one-centered-header="true"] > :last-child { grid-row:2; }
      .agent-chat-header[data-one-centered-header="true"] > :last-child { grid-column:2; }
    }`;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-surface-"));
  fs.writeFileSync(path.join(dir, "fixture.css"), css);
  fs.writeFileSync(
    path.join(dir, "fixture.html"),
    `<!doctype html><html${variant.welcomeTheme ? ` class="${variant.welcomeTheme}"` : ""}><head><meta charset="utf-8">
<!-- Load-bearing on the mobile projects. A page with no viewport meta gets the
     980px fallback layout viewport under \`isMobile\`, so every width below it
     measures the same 980px-wide header scaled down, and the widths this file
     names would be a fiction. -->
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="fixture.css">
<style>${TOKENS}
:root { --agent-chat-header-safe-top:${variant.safeTop ?? 0}px; --agent-chat-header-height:calc(60px + var(--agent-chat-header-safe-top)); }
${geometry}
${productFontStyle()}
</style></head><body>
<div id="screen"></div>
<script>
  const SCREENS = ${JSON.stringify(screens)};
  function render(mode) {
    document.getElementById("screen").innerHTML = SCREENS[mode];
    document.documentElement.dataset.mode = mode;
  }
  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target.closest("[data-mode]") : null;
    if (target) render(target.getAttribute("data-mode"));
  });
  render("one");
</script>
</body></html>`,
  );
  const url = `file://${path.join(dir, "fixture.html")}`;
  fixtureCache.set(key, url);
  return url;
}

async function openFixture(page: Page, variant: Variant, width: number) {
  await page.setViewportSize({ width, height: 844 });
  await page.goto(await buildFixture(variant, width));
  await awaitProductFont(page);
  await expect(page.getByTestId("agent-toggle")).toBeVisible();
}

function segment(mode: Mode) {
  const option = SRC.toggle.options.find(
    (candidate) => candidate.value === mode,
  );
  if (!option) throw new Error(`no "${mode}" segment in the shipped toggle`);
  return option;
}

/** Press the segment by the name a screen reader would read out. */
async function switchTo(page: Page, mode: Mode) {
  const option = segment(mode);
  await page
    .locator(`[aria-label="${option.accessibleLabel ?? option.label}"]`)
    .click();
  await expect(page.locator("html")).toHaveAttribute("data-mode", mode);
}

/**
 * Every model control the reader can SEE, from either agent, by the selectors
 * the two shipped controls actually carry. Visibility is the whole point: the
 * off-screen agent stays mounted behind display:none, so a bare DOM count
 * would report two controls on a screen showing one.
 */
function visibleModelControls(page: Page) {
  return page.locator(
    `[data-testid="${SRC.cloudPicker.testId}"]:visible, [title="${SRC.puppy.pickerTitle}"]:visible`,
  );
}

/**
 * Everything the reader can actually read: visible text plus the `title` and
 * accessible name of every visible element. `innerText` already excludes the
 * display:none subtrees, which is the point.
 */
async function visibleClaims(page: Page): Promise<string> {
  return page.evaluate(() => {
    const root = document.getElementById("screen");
    if (!root) return "";
    const parts = [root.innerText];
    for (const element of Array.from(root.querySelectorAll("*"))) {
      if (element.getClientRects().length === 0) continue;
      const title = element.getAttribute("title");
      const label = element.getAttribute("aria-label");
      if (title) parts.push(title);
      if (label) parts.push(label);
    }
    return parts.join("\n");
  });
}

async function box(page: Page, testId: string) {
  const rect = await page.locator(`[data-testid="${testId}"]`).boundingBox();
  if (!rect) throw new Error(`[data-testid="${testId}"] has no layout box`);
  return rect;
}

test.describe("Agent Chat: which agent is answering", () => {
  test("Puppy mode carries exactly one model control, and it is not a cloud one", async ({
    page,
  }) => {
    await openFixture(page, SHIPPED, 768);

    // One first, so the picker is proven to exist before its absence means
    // anything. A gate stuck shut would fail here, not silently pass below.
    await expect(visibleModelControls(page)).toHaveCount(1);
    await expect(page.getByTestId(SRC.cloudPicker.testId)).toBeVisible();
    await expect(page.getByTestId(SRC.cloudPicker.testId)).toHaveText(
      cloudChipLabel(),
    );
    expect(await visibleClaims(page)).toMatch(CLOUD_VENDOR);

    await switchTo(page, "puppy");

    // THE REPORTED DEFECT. Absent from the document, not merely hidden: an
    // option in that menu writes One's model preference, and the write must
    // not stay reachable from the on-device surface.
    await expect(page.getByTestId(SRC.cloudPicker.testId)).toHaveCount(0);
    await expect(
      page.locator(`[aria-label="${SRC.cloudPicker.ariaLabel}"]`),
    ).toHaveCount(0);

    // And the symptom, not just the selector: no cloud model name reaches the
    // reader here by any route -- text, tooltip or accessible name.
    expect(await visibleClaims(page)).not.toMatch(CLOUD_VENDOR);

    // Exactly one model control on screen, and it is Puppy One's.
    await expect(visibleModelControls(page)).toHaveCount(1);
    await expect(
      page.locator(`[title="${SRC.puppy.pickerTitle}"]`),
    ).toBeVisible();
  });

  test("the header names the agent on screen, and the mode switches name and controls together", async ({
    page,
  }) => {
    await openFixture(page, SHIPPED, 1024);

    const oneOption = segment("one");
    const puppyOption = segment("puppy");
    // The names come from the shipped ternary, not from this file, so a rename
    // travels here instead of turning the spec red for the wrong reason.
    const oneName = decide("one", SHIPPED).name;
    const puppyName = decide("puppy", SHIPPED).name;
    expect(puppyName).not.toBe(oneName);

    await expect(page.getByTestId("agent-name")).toHaveText(oneName);
    if (decide("one", SHIPPED).subtitle) {
      await expect(page.getByTestId("agent-subtitle")).toHaveText(
        decide("one", SHIPPED).subtitle,
      );
    } else {
      // ChatAgentSubtitle returns null at rest; no fabricated idle line.
      await expect(page.getByTestId("agent-subtitle")).toHaveCount(0);
    }
    await expect(
      page.locator(`[aria-label="${oneOption.accessibleLabel}"]`),
    ).toHaveAttribute("aria-checked", "true");

    await switchTo(page, "puppy");

    // The name is the reader's only guarantee about which agent is answering,
    // so it names the agent on screen, not the workspace.
    await expect(page.getByTestId("agent-name")).toHaveText(puppyName);
    await expect(page.getByTestId("agent-subtitle")).toHaveCount(0);
    await expect(
      page.locator(`[aria-label="${puppyOption.accessibleLabel}"]`),
    ).toHaveAttribute("aria-checked", "true");

    // The selected agent's concise authored name matches native and web.
    expect(puppyOption.accessibleLabel).toBe("Puppy One");
    expect(oneOption.accessibleLabel ?? "").toMatch(/cloud/i);

    // Name and controls moved in the same render: the surface below is Puppy's
    // and One's picker is gone, under a header that now says "Puppy One".
    await expect(page.getByTestId("puppy-surface")).toBeVisible();
    await expect(page.getByTestId(SRC.cloudPicker.testId)).toHaveCount(0);
  });

  test("One's transcript and composer leave the accessibility tree without leaving the document", async ({
    page,
  }) => {
    await openFixture(page, SHIPPED, 1024);
    await expect(
      page.getByRole("textbox", { name: SRC.oneComposer.ariaLabel }),
    ).toBeVisible();
    // Puppy One is mounted on first use and hidden thereafter, never
    // unmounted, so the fixture's "hidden Puppy" state is the state a reader
    // is actually in after one visit. Unmounting it destroyed the whole local
    // conversation on every glance back at One.
    expect(SRC.visibility.puppyMountedLazily).toBe(true);

    await switchTo(page, "puppy");

    // Out of the accessibility tree and the tab order: a message typed here
    // would go to the cloud agent under a header that says "Puppy One".
    // Playwright's role engine skips hidden elements, so this is the a11y tree
    // and not a CSS assertion dressed as one.
    await expect(
      page.getByRole("textbox", { name: SRC.oneComposer.ariaLabel }),
    ).toHaveCount(0);
    await expect(page.getByTestId("one-transcript")).toBeHidden();

    // Still in the document, though. `hidden` and not unmounted is what keeps
    // a cloud turn in flight alive through a glance at the other agent, and a
    // "fix" that unmounted it would destroy the stream and pass a naive
    // visibility check. Both halves are pinned.
    await expect(
      page.getByRole("textbox", {
        name: SRC.oneComposer.ariaLabel,
        includeHidden: true,
      }),
    ).toHaveCount(1);

    // Symmetrically, Puppy One is the one hidden in One mode, so a local
    // answer that takes tens of seconds survives a glance the other way.
    await switchTo(page, "one");
    await expect(page.getByTestId("puppy-surface")).toBeHidden();
    await expect(page.getByTestId("puppy-surface")).toHaveCount(1);
    await expect(
      page.getByRole("textbox", { name: SRC.oneComposer.ariaLabel }),
    ).toBeVisible();
  });

  for (const width of WIDTHS) {
    test(`the agent mark stays visible in the header at ${width}px`, async ({
      page,
    }) => {
      await openFixture(page, SHIPPED, width);

      const brandTile = page.getByTestId("agent-brand-tile");
      await expect(brandTile).toBeVisible();

      const tile = await box(page, "agent-brand-tile");
      const header = await box(page, "agent-header");
      if (width < 640) {
        const identity = await box(page, "agent-identity");
        expect(tile.x).toBeCloseTo(identity.x, 0);
      }
      expect(tile.width).toBeGreaterThan(0);
      expect(tile.height).toBeGreaterThan(0);
      expect(tile.x).toBeGreaterThanOrEqual(header.x - 0.5);
      expect(tile.x + tile.width).toBeLessThanOrEqual(
        header.x + header.width + 0.5,
      );
      await switchTo(page, "puppy");
      await expect(page.getByTestId("one-artwork")).toBeVisible();
      expect(await box(page, "agent-brand-tile")).toEqual(tile);
    });

    test(`the header cluster does not move when the mode changes at ${width}px`, async ({
      page,
    }) => {
      await openFixture(page, SHIPPED, width);

      const profileTarget = await box(page, "profile-open-button");
      const profilePhoto = await box(page, "profile-photo");
      expect(profileTarget.width).toBeGreaterThanOrEqual(44);
      expect(profileTarget.height).toBeGreaterThanOrEqual(44);
      expect(profilePhoto.width).toBe(32);
      expect(profilePhoto.height).toBe(32);

      const before = {
        toggle: await box(page, "agent-toggle"),
        cluster: await box(page, "agent-header-cluster"),
        header: await box(page, "agent-header"),
      };

      await switchTo(page, "puppy");

      const after = {
        toggle: await box(page, "agent-toggle"),
        cluster: await box(page, "agent-header-cluster"),
        header: await box(page, "agent-header"),
      };

      // Order is why this holds: the picker leaves on the far side of the
      // toggle, which is anchored to the profile button at the right edge. Put
      // the picker between them and its exit drags the toggle sideways out
      // from under the thumb that just pressed it.
      expect(Math.abs(after.toggle.x - before.toggle.x)).toBeLessThanOrEqual(
        0.5,
      );
      expect(
        Math.abs(after.toggle.width - before.toggle.width),
      ).toBeLessThanOrEqual(0.5);
      expect(Math.abs(after.toggle.y - before.toggle.y)).toBeLessThanOrEqual(
        0.5,
      );

      // The right-hand cluster keeps its right edge (it narrows by exactly the
      // picker it lost), and stays on the page.
      expect(
        Math.abs(
          after.cluster.x +
            after.cluster.width -
            (before.cluster.x + before.cluster.width),
        ),
      ).toBeLessThanOrEqual(0.5);
      expect(after.cluster.x + after.cluster.width).toBeLessThanOrEqual(
        width + 0.5,
      );
      expect(after.cluster.x).toBeGreaterThanOrEqual(-0.5);

      // And the header does not grow a line on the longer name: "Puppy One"
      // is three times "One", and the identity block it sits in is the half
      // that is allowed to shrink.
      expect(after.header.height).toBe(before.header.height);
      expect(before.header.height).toBeGreaterThan(60);

      // Nothing slides under a control: the identity region ends before the
      // actions begin, in both modes. This is the 390px defect where the brand
      // tile painted under the toggle and the name collapsed to zero width.
      for (const mode of ["puppy", "one"] as const) {
        if (mode === "one") await switchTo(page, "one");
        const identity = await box(page, "agent-identity");
        const cluster = await box(page, "agent-header-cluster");
        const disjoint = identity.y + identity.height <= cluster.y + 0.5 || identity.x + identity.width <= cluster.x + 0.5;
        expect(disjoint, "Identity and actions must occupy separate tracks, never overlap").toBe(true);

        expect((await box(page, "agent-name")).width).toBeGreaterThan(0);
        // Identity and controls are side by side, not two separate app-bar rows.
        expect((await box(page, "agent-header")).height).toBeGreaterThanOrEqual(60);
        const name = page.getByTestId("agent-name");
        expect(await name.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      }
    });
  }

  test("active tool status cannot overlap the full action cluster at constrained widths", async ({ page }) => {
    for (const width of [768, 1024, 1280]) {
      await openFixture(page, SHIPPED, width);
      // Public synthetic status exercises the streaming state omitted by the
      // idle fixture. No real prompt or tool payload enters layout artifacts.
      await page.getByTestId("agent-identity").locator("div.min-w-0").evaluate((element) => {
        const status = document.createElement("p");
        status.textContent = "Searching connected information";
        element.append(status);
      });
      const identity = await box(page, "agent-identity");
      const actions = await box(page, "agent-header-cluster");
      expect(identity.y + identity.height <= actions.y + 0.5 || identity.x + identity.width <= actions.x + 0.5).toBe(true);
      expect(actions.x + actions.width).toBeLessThanOrEqual(width + 0.5);
    }
  });

  test("a person with a single cloud model gets no picker, and the toggle still holds still", async ({
    page,
  }) => {
    // No picker in either mode: the header holds no space for a control this
    // person never sees. That is a second shape the stability property has to
    // survive.
    await openFixture(page, SINGLE_MODEL, 390);
    await expect(page.getByTestId(SRC.cloudPicker.testId)).toHaveCount(0);
    const before = await box(page, "agent-toggle");

    await switchTo(page, "puppy");

    const after = await box(page, "agent-toggle");
    expect(Math.abs(after.x - before.x)).toBeLessThanOrEqual(0.5);
    await expect(visibleModelControls(page)).toHaveCount(1);
  });

  test("the defect as reported fails every check above", async ({ page }) => {
    /*
     * The mutation half, run as a test rather than by hand.
     *
     * This renders the header WITHOUT the surface guard -- the exact shape the
     * defect shipped as, with the picker gated only on the model preference.
     * Everything else is identical. If these expectations ever start failing,
     * the checks above have stopped being able to see the defect they exist
     * for, and are passing for some other reason.
     */
    await openFixture(page, AS_REPORTED, 768);
    await switchTo(page, "puppy");

    await expect(page.getByTestId("agent-name")).toHaveText(
      decide("puppy", AS_REPORTED).name,
    );

    // Two model pickers on one screen, disagreeing about which model answers.
    await expect(visibleModelControls(page)).toHaveCount(2);
    await expect(page.getByTestId(SRC.cloudPicker.testId)).toBeVisible();

    // A cloud model named on the surface whose whole claim is that the answer
    // was generated on the owner's machine.
    expect(await visibleClaims(page)).toMatch(CLOUD_VENDOR);
  });
});

test.describe("Empty One chat: welcome spacing", () => {
  test("detects the previous viewport-centered gap", async ({ page }) => {
    await openFixture(page, { ...SINGLE_MODEL, centeredHeader: true, welcomeName: "Smirthika" }, 1920);
    // Negative control: the reported layout reserved up to 32rem and centered
    // the welcome inside it, independently of the header directly above it.
    await page.addStyleTag({ content: '[data-testid="welcome"] { min-height: clamp(18rem, 45vh, 32rem); justify-content: center; padding-block: 2.5rem; }' });
    const gaps: number[] = [];
    for (const height of [600, 1080]) {
      await page.setViewportSize({ width: 1920, height });
      const identity = await box(page, "agent-identity");
      const heading = await box(page, "welcome-heading");
      gaps.push(heading.y - identity.y - identity.height);
    }
    expect(gaps[1]).toBeGreaterThan(64);
    expect(gaps[1] - gaps[0]).toBeGreaterThan(64);
  });

  test("keeps the greeting close to the identity at every viewport height", async ({ page }) => {
    for (const width of [390, 1920]) {
      const gaps: number[] = [];
      for (const height of [390, 600, 1080]) {
        await openFixture(page, { ...SINGLE_MODEL, centeredHeader: true, safeTop: width < 768 ? 44 : 0, welcomeName: "Smirthika" }, width);
        await page.setViewportSize({ width, height });
        const identity = await box(page, "agent-identity");
        const heading = await box(page, "welcome-heading");
        const gap = heading.y - identity.y - identity.height;
        gaps.push(gap);
        expect(gap).toBeGreaterThanOrEqual(16);
        expect(gap).toBeLessThanOrEqual(64);
        await page.screenshot({ path: test.info().outputPath(`welcome-${width}x${height}px.png`) });
      }
      expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThanOrEqual(1);
      await test.info().attach(`welcome-gaps-${width}px`, { body: JSON.stringify({ width, heights: [390, 600, 1080], gaps }), contentType: "application/json" });
    }
  });

  test("keeps welcome text within the reading column on small and large screens", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    for (const [width, height] of [[320, 568], [390, 844], [844, 390], [768, 1024], [1280, 720], [2560, 1440]]) {
      for (const [name, welcomeTheme] of [["there", "light"], ["Smirthika", "light"], ["Zoë 🦋", "dark"], ["نور", "dark"], ["A".repeat(64), "light"]] as const) {
        await openFixture(page, { ...SINGLE_MODEL, centeredHeader: true, safeTop: width < 768 ? 44 : 0, welcomeName: name, welcomeTheme }, width);
        await page.setViewportSize({ width, height });
        const geometry = await page.getByTestId("welcome-heading").evaluate(element => {
          const rect = element.getBoundingClientRect();
          return { left: rect.left, right: rect.right, top: rect.top, scrollWidth: element.scrollWidth, width: element.clientWidth };
        });
        const identity = await box(page, "agent-identity");
        const gap = geometry.top - identity.y - identity.height;
        expect(gap).toBeGreaterThanOrEqual(16);
        expect(gap).toBeLessThanOrEqual(64);
        expect(geometry.left).toBeGreaterThanOrEqual(0);
        expect(geometry.right).toBeLessThanOrEqual(width);
        expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width);
        const transcript = await page.getByTestId("one-transcript").evaluate(element => ({ scroll: element.scrollWidth, width: element.clientWidth }));
        expect(transcript.scroll).toBeLessThanOrEqual(transcript.width);
      }
    }
  });
});

test.describe("One portrait header: responsive restoration", () => {
  test("retains compact artwork and reservation for coherent native chrome", async ({ page }) => {
    for (const width of [393, 768]) {
      await openFixture(page, { ...SHIPPED, centeredHeader: false }, width);
      expect((await box(page, "agent-header")).height).toBe(60);
      expect((await box(page, "one-profile-button")).width).toBe(44);
      expect((await box(page, "one-artwork")).width).toBe(32);
    }
  });

  test("keeps the portrait above its name and all controls reachable without overlap", async ({
    page,
  }) => {
    for (const width of [320, 332, 360, 393, 430, 640, 767]) {
      for (const canPickOneModel of [false, true]) {
        const safeTop = width === 393 ? 64 : width === 360 ? 0 : 32;
        const variant = {
          ...SHIPPED,
          canPickOneModel,
          centeredHeader: true,
          safeTop,
          workingSubtitle: "Checking your upcoming calendar appointments…",
        };
        await openFixture(page, variant, width);
        const targets = [
          "history-button",
          "one-profile-button",
          ...(decide("one", variant, width).showPicker ? [SRC.cloudPicker.testId] : []),
          "agent-toggle",
          "profile-open-button",
        ];
        const boxes = await Promise.all(targets.map((id) => box(page, id)));
        for (const rect of boxes) {
          expect(rect.width).toBeGreaterThanOrEqual(44);
          expect(rect.height).toBeGreaterThanOrEqual(44);
          expect(rect.y).toBe(boxes[0].y);
          expect(rect.x).toBeGreaterThanOrEqual(0);
          expect(rect.x + rect.width).toBeLessThanOrEqual(width);
        }
        for (let i = 1; i < boxes.length; i++)
          expect(boxes[i].x).toBeGreaterThanOrEqual(
            boxes[i - 1].x + boxes[i - 1].width,
          );
        for (const radio of await page.getByRole("radio").all()) {
          const target = await radio.boundingBox();
          expect(target?.width).toBeGreaterThanOrEqual(44);
          expect(target?.height).toBeGreaterThanOrEqual(44);
        }
        const identity = await box(page, "agent-identity");
        const avatar = await box(page, "one-profile-button");
        const name = await box(page, "agent-name");
        expect(avatar.x).toBeGreaterThanOrEqual(identity.x);
        expect(name.y).toBeGreaterThanOrEqual(avatar.y + avatar.height);
        await expect(page.getByTestId("agent-name")).toBeVisible();
        expect(
          await page
            .getByTestId("agent-name")
            .evaluate((el) => el.scrollWidth <= el.clientWidth),
        ).toBe(true);
        const oneTarget = await box(page, "one-profile-button");
        // WebKit resolves viewport clamps on a 1/64px grid.
        const expectedArtwork = Math.min(64, Math.max(52, width - 268));
        expect(oneTarget.width).toBeCloseTo(expectedArtwork, 1);
        expect(oneTarget.height).toBeCloseTo(expectedArtwork, 1);
        const artwork = await box(page, "one-artwork");
        expect(artwork.width).toBeCloseTo(expectedArtwork, 1);
        expect(artwork.height).toBeCloseTo(expectedArtwork, 1);
        await expect(page.getByTestId("agent-name")).toHaveText("One");
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        const header = await box(page, "agent-header");
        expect(header.height).toBeCloseTo(expectedArtwork + 64 + safeTop, 1);
        expect(name.y + name.height).toBeLessThanOrEqual(
          header.y + header.height - 8,
        );
        if (decide("one", variant, width).showPicker) {
          const picker = await box(page, SRC.cloudPicker.testId);
          expect(picker.y).toBe(boxes[0].y);
          await expect(
            page
              .getByTestId(SRC.cloudPicker.testId)
              .locator(".agent-chat-model-icon"),
          ).toBeVisible();
          expect(picker.height).toBeGreaterThanOrEqual(44);
          expect(picker.x + picker.width).toBeLessThanOrEqual(width);
        }
        await page.getByTestId("agent-name").evaluate(el => { el.textContent = "A much longer saved private agent name"; });
        const longName = await box(page, "agent-name");
        const longLabel = (await page.getByTestId("agent-name").locator("..").boundingBox())!;
        expect(longName.x).toBeGreaterThanOrEqual(0);
        expect(longName.x + longName.width).toBeLessThanOrEqual(width);
        expect(longName.y).toBe(name.y);
        expect(longName.height).toBe(name.height);
        expect(longName.x).toBeGreaterThanOrEqual(longLabel.x);
        expect(longName.x + longName.width).toBeLessThanOrEqual(longLabel.x + longLabel.width);
        expect(Math.abs(longLabel.x + longLabel.width / 2 - (avatar.x + avatar.width / 2))).toBeLessThanOrEqual(1);
        expect(longName.y + longName.height).toBeLessThanOrEqual(header.y + header.height - 8);
        await expect(page.getByTestId("agent-name")).toHaveCSS("text-overflow", "ellipsis");
      }
    }
  });

  test("preserves desktop geometry at the breakpoint and wider screens", async ({
    page,
  }) => {
    for (const width of [768, 1024, 1440]) {
      const variant = { ...SHIPPED, centeredHeader: true };
      await openFixture(page, variant, width);
      const portrait = await box(page, "one-profile-button");
      expect(portrait.width).toBe(104);
      expect((await box(page, "one-artwork")).width).toBe(104);
      expect(portrait.x + portrait.width / 2).toBeCloseTo(width / 2, 0);
      for (const id of ["history-button", "agent-toggle", "profile-open-button", SRC.cloudPicker.testId]) {
        const target = await box(page, id);
        expect(target.width).toBeGreaterThanOrEqual(44);
        expect(target.height).toBeGreaterThanOrEqual(44);
        expect(target.x + target.width).toBeLessThanOrEqual(width);
      }
      await openFixture(page, { ...variant, workingSubtitle: "Checking your upcoming calendar appointments…" }, width);
      const activeHeader = await box(page, "agent-header");
      const subtitle = await box(page, "agent-subtitle");
      expect(subtitle.y + subtitle.height).toBeLessThanOrEqual(activeHeader.y + activeHeader.height);
    }
  });

  test("detects the previous stacked phone header", async ({ page }) => {
    await openFixture(
      page,
      { ...SINGLE_MODEL, centeredHeader: true, stackedPhoneCss: true },
      393,
    );
    const avatar = await box(page, "one-profile-button");
    const history = await box(page, "history-button");
    expect(
      Math.abs(avatar.y + avatar.height / 2 - history.y - history.height / 2),
    ).toBeGreaterThan(40);
  });
});
