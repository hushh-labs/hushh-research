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
 * fold it into the slot around it, and the fixture's screen changes with the
 * product's. A stale copy of any of it fails at build time, loudly, by name.
 *
 * WHY A NAIVE VERSION OF THIS TEST WOULD LIE
 * ------------------------------------------
 *   - Asserting only "no element with the picker's testid" would pass against
 *     a header that still SHOWS a cloud model somewhere else. The check here
 *     is the symptom, not the selector: no cloud model name may reach the
 *     reader in Puppy mode, by visible text, `title` or accessible name.
 *   - Asserting only "the picker is gone" would pass against a fix that drops
 *     the reserved slot with it, sliding the mode toggle sideways under the
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

const WIDTHS = [360, 390, 430, 768, 1024, 1280] as const;

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
  /** Whether this person has more than one cloud model to choose between. */
  canPickOneModel: boolean;
  /**
   * `false` reproduces the header AS REPORTED: no reserved slot, and One's
   * picker gated only on `modelPreference && modelPreference.choices.length > 1`.
   *
   * That condition is retyped here on purpose, from the defect's own diff, and
   * is the only retyped condition in this file. It has to be: it no longer
   * exists in the shipped source to extract, and pinning the negative control
   * to today's slot markup would make it fail for reasons that have nothing to
   * do with the defect it exists to reproduce.
   */
  applyShippedGate: boolean;
}

const SHIPPED: Variant = { canPickOneModel: true, applyShippedGate: true };
const SINGLE_MODEL: Variant = { canPickOneModel: false, applyShippedGate: true };
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
function decide(mode: Mode, variant: Variant) {
  const scope = {
    isPuppySurface: mode === "puppy",
    canPickOneModel: variant.canPickOneModel,
    modelPreference: MODEL_PREFERENCE,
  };
  const slotted = variant.applyShippedGate
    ? Boolean(evaluateShippedExpression(SRC.cloudPicker.slotExpression, scope))
    : // The defect had no reserved slot; the picker sat in the cluster bare.
      false;
  const showPicker = variant.applyShippedGate
    ? slotted &&
      Boolean(evaluateShippedExpression(SRC.cloudPicker.gateExpression, scope))
    : MODEL_PREFERENCE.choices.length > 1;
  return {
    name: String(evaluateShippedExpression(SRC.header.nameExpression, scope)),
    subtitle: String(
      evaluateShippedExpression(SRC.header.subtitleExpression, scope),
    ),
    showSlot: slotted,
    showPicker,
    oneHidden: String(
      evaluateShippedExpression(SRC.visibility.oneHiddenExpression, scope) || "",
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

function renderScreen(mode: Mode, variant: Variant): string {
  const plan = decide(mode, variant);

  const segments = SRC.toggle.options
    .map((option) => {
      const active = option.value === mode;
      return `<button type="button" role="radio" data-mode="${option.value}"
        aria-checked="${active}" aria-label="${escapeHtml(option.accessibleLabel ?? option.label)}"
        class="${SRC.toggle.segmentClass}${active ? " bg-background text-foreground shadow-sm" : " text-muted-foreground"}"
      >${escapeHtml(option.label)}</button>`;
    })
    .join("");

  const picker = plan.showPicker
    ? `<button type="button" role="combobox"
         data-testid="${SRC.cloudPicker.testId}"
         aria-label="${escapeHtml(SRC.cloudPicker.ariaLabel)}"
         title="${escapeHtml(cloudChipTitle())}"
         class="${SRC.cloudPicker.triggerClass} inline-flex items-center"
       ><span class="truncate">${escapeHtml(cloudChipLabel())}</span></button>`
    : "";

  // The shipped header wraps the picker in a reserved slot. The header as
  // reported had no slot, so the picker hangs in the cluster on its own.
  const slot = plan.showSlot
    ? `<span class="${SRC.cloudPicker.slotClass}">${picker}</span>`
    : picker;

  const statusText = mode === "puppy" ? "One is still working" : "Thinking";

  const header = `
    <div data-testid="agent-header" class="${SRC.header.containerClass}">
      <div class="${SRC.header.identityClass}">
        <div class="grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-[13px] bg-[color:var(--app-accent-soft)]"></div>
        <div class="min-w-0">
          <div data-testid="agent-name" class="${SRC.header.nameClass}">${escapeHtml(plan.name)}</div>
          <p data-testid="agent-subtitle" class="${SRC.header.subtitleClass}">${escapeHtml(plan.subtitle)}</p>
        </div>
      </div>
      <div data-testid="agent-header-cluster" class="${SRC.header.clusterClass}">
        <div role="radiogroup" data-testid="agent-toggle" aria-label="${escapeHtml(SRC.toggle.ariaLabel)}"
             class="${SRC.toggle.containerClass} w-auto shrink-0">${segments}</div>
        ${slot}
        <span class="${SRC.header.statusClass}" role="status" aria-live="polite">${escapeHtml(statusText)}</span>
      </div>
    </div>`;

  /*
   * Puppy One's surface. Only the two things this spec measures are modelled:
   * its own model control (the real `PuppyModelPicker` trigger's classes and
   * title, extracted) and its own composer. The pill reports a local weight
   * file, which is what makes the "no cloud model name on this screen" sweep
   * meaningful rather than tautological.
   */
  const puppySurface = `
    <section data-agent-surface="puppy" data-testid="puppy-surface"
             class="flex min-h-0 flex-1 flex-col overflow-hidden px-4 pb-3 pt-5 sm:px-6 ${plan.puppyHidden}">
      <div class="mx-auto flex min-h-0 w-full max-w-4xl flex-1 flex-col gap-3">
        <div class="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-border/60 bg-background">
          <div class="${SRC.puppy.panelHeaderClass}">
            <span class="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 bg-[color:var(--app-success-tint)] text-[color:var(--app-success-deep)]">${escapeHtml(PUPPY_MODEL)}</span>
            <button type="button" class="${SRC.puppy.pickerClass} ml-auto"
                    title="${escapeHtml(SRC.puppy.pickerTitle)}">${escapeHtml(PUPPY_MODEL)}</button>
            <button type="button" aria-pressed="true"
                    class="rounded-full px-2 py-0.5 text-[11px] font-medium">${escapeHtml(SRC.puppy.pinOnLabel)}</button>
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
  const oneTranscript = `
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
async function buildFixture(variant: Variant): Promise<string> {
  const key = JSON.stringify(variant);
  const cached = fixtureCache.get(key);
  if (cached) return cached;

  const screens: Record<Mode, string> = {
    one: renderScreen("one", variant),
    puppy: renderScreen("puppy", variant),
  };

  const used = new Set<string>();
  for (const markup of Object.values(screens)) {
    for (const match of markup.matchAll(/class="([^"]*)"/g)) {
      for (const token of match[1].split(/\s+/)) if (token) used.add(token);
    }
  }
  const css = await compileTailwind(used);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-surface-"));
  fs.writeFileSync(path.join(dir, "fixture.css"), css);
  fs.writeFileSync(
    path.join(dir, "fixture.html"),
    `<!doctype html><html><head><meta charset="utf-8">
<!-- Load-bearing on the mobile projects. A page with no viewport meta gets the
     980px fallback layout viewport under \`isMobile\`, so every width below it
     measures the same 980px-wide header scaled down, and the widths this file
     names would be a fiction. -->
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="fixture.css">
<style>${TOKENS}
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
  await page.goto(await buildFixture(variant));
  await awaitProductFont(page);
  await expect(page.getByTestId("agent-toggle")).toBeVisible();
}

function segment(mode: Mode) {
  const option = SRC.toggle.options.find((candidate) => candidate.value === mode);
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
    await openFixture(page, SHIPPED, 390);

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
    await expect(page.getByTestId("agent-subtitle")).toBeVisible();
    await expect(
      page.locator(`[aria-label="${oneOption.accessibleLabel}"]`),
    ).toHaveAttribute("aria-checked", "true");

    await switchTo(page, "puppy");

    // The name is the reader's only guarantee about which agent is answering,
    // so it names the agent on screen, not the workspace.
    await expect(page.getByTestId("agent-name")).toHaveText(puppyName);
    await expect(
      page.locator(`[aria-label="${puppyOption.accessibleLabel}"]`),
    ).toHaveAttribute("aria-checked", "true");

    // The spoken label says what is being chosen; "One" and "Puppy" alone do
    // not. Both options carry one, and it names the machine for Puppy.
    expect(puppyOption.accessibleLabel ?? "").toMatch(/on your machine/i);
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
    test(`the header cluster does not move when the mode changes at ${width}px`, async ({
      page,
    }) => {
      await openFixture(page, SHIPPED, width);

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

      // The reserved slot is why this holds: it is guarded on whether this
      // person HAS a picker, never on which surface is showing. Fold the mode
      // into that guard and the slot collapses, dragging the toggle sideways
      // out from under the thumb that just pressed it.
      expect(SRC.cloudPicker.slotExpression).not.toContain("isPuppySurface");
      expect(Math.abs(after.toggle.x - before.toggle.x)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(after.toggle.width - before.toggle.width)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(after.toggle.y - before.toggle.y)).toBeLessThanOrEqual(0.5);

      // The whole right-hand cluster keeps its box, and stays on the page.
      expect(Math.abs(after.cluster.width - before.cluster.width)).toBeLessThanOrEqual(0.5);
      expect(after.cluster.x + after.cluster.width).toBeLessThanOrEqual(width + 0.5);
      expect(after.cluster.x).toBeGreaterThanOrEqual(-0.5);

      // And the header does not grow a line on the longer name: "Puppy One"
      // is three times "One", and the identity block it sits in is the half
      // that is allowed to shrink.
      expect(Math.abs(after.header.height - before.header.height)).toBeLessThanOrEqual(0.5);
    });
  }

  test("a person with a single cloud model gets no reserved slot, and the toggle still holds still", async ({
    page,
  }) => {
    // The slot is reserved only for someone who HAS a picker; the header must
    // not hold space for a control they never see. That is a second shape the
    // stability property has to survive.
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
    await openFixture(page, AS_REPORTED, 390);
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
