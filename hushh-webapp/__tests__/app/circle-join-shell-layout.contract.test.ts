import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * /circle/join renders INSIDE the signed-in shell.
 *
 * Its route-layout contract entry says `mode: "redirect"`, which reads like an
 * opt-out but is a runtime no-op: only `"flow"`, `"hidden"` and the separate
 * `persistentChrome: "none"` flag change chrome, so this route draws the top
 * bar and the bottom "Talk to One" composer like any standard route.
 *
 * The shell reserves both edges on the page's behalf -- app/providers.tsx
 * renders a `data-app-shell-top-spacer` sized to `--app-top-content-offset`
 * ahead of the page, and the scroll root carries `--app-scroll-bottom-pad`.
 * A viewport height on the page root therefore double-counts that reservation.
 * That is what shipped: `min-h-[100svh] ... justify-center` centred the
 * invitation against the whole viewport, pushing it under the header and
 * leaving a dead scroll region above the composer on every phone.
 *
 * These are source-text assertions on purpose. The regression is structural --
 * the screen can render every control correctly and still be wrong by sizing
 * itself against the viewport instead of its content.
 */
const RAW = readFileSync(join(process.cwd(), "app/circle/join/page.tsx"), "utf8");

/**
 * Assert on code, not prose. Every banned token below is also a word an author
 * needs in order to explain WHY it is banned; scanning the comments too would
 * mean the only way to pass this gate is to delete the explanation.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join("\n");
}

const SOURCE = stripComments(RAW);

describe("/circle/join shell layout contract", () => {
  it("measures to its content instead of the viewport", () => {
    // The whole defect, in four assertions.
    expect(SOURCE).not.toContain("100svh");
    expect(SOURCE).not.toContain("100dvh");
    expect(SOURCE).not.toContain("100vh");
    expect(SOURCE).not.toContain("min-h-screen");
    // Centring a whole column is the other half of the defect: it is what put
    // the invitation under the header once the column outgrew the shell's
    // available height. (`justify-center` alone is fine -- the icon tile
    // centres its glyph with it.)
    expect(SOURCE).not.toContain("flex-col justify-center");

    // AppPageShell owns the measure, the inline gutters and the bottom
    // clearance; `fitContent` is the flag written for exactly this symptom.
    expect(SOURCE).toContain("<AppPageShell");
    expect(SOURCE).toContain("fitContent");
  });

  it("keeps the invitation at one readable column on a laptop", () => {
    // `.app-page-shell[data-app-shell-width="reading"]` (54rem) outranks any
    // utility class, so a `max-w-*` here is silently dead and the invitation
    // stretches to 864px. The measure must be an inline style to win.
    expect(SOURCE).toContain('maxWidth: "30rem"');
    expect(SOURCE).toContain("style={INVITE_MEASURE}");
  });

  it("never re-reserves space the shell already reserves", () => {
    // Padding by these tokens doubles the clearance the scroll root applies.
    expect(SOURCE).not.toContain("--app-top-content-offset");
    expect(SOURCE).not.toContain("--app-scroll-bottom-pad");
    expect(SOURCE).not.toContain("--onboarding-agent-bar-clearance");
    expect(SOURCE).not.toContain("--app-bottom-fixed-ui");
  });

  it("does not escape the shell or outrank its chrome", () => {
    // A flow that goes fixed/absolute over the viewport covers the top bar
    // rather than scrolling beneath it.
    expect(SOURCE).not.toContain("fixed inset-0");
    expect(SOURCE).not.toMatch(/\bz-\[\d+\]/);
    expect(SOURCE).not.toContain("position: fixed");
  });

  it("lets the shared header own the h1 and the icon tile", () => {
    expect(SOURCE).toContain("<PageHeader");
    expect(SOURCE).not.toContain("<h1");
    // The top bar owns back on every in-shell surface.
    expect(SOURCE).not.toContain("ChevronLeft");
    // --app-accent-soft is referenced across the repo but defined nowhere, so
    // a tile painted with it has no background at all. Use an accent-derived
    // tint that actually resolves, and that follows the accent preference.
    expect(SOURCE).not.toContain("--app-accent-soft");
    expect(SOURCE).toContain("bg-[color:var(--app-accent)]/12");
  });

  it("uses design-system components instead of hand-rolled recipes", () => {
    // The hand-rolled pill dropped the focus ring, the disabled state and the
    // loading affordance that <Button> already ships.
    expect(SOURCE).toContain("<Button");
    expect(SOURCE).not.toContain("rounded-full bg-[color:var(--app-accent)]");
    expect(SOURCE).not.toContain("h-14 w-full");
    // Destructive colour is a token in both appearances, not a literal pair.
    expect(SOURCE).toContain("var(--app-destructive)");
    expect(SOURCE).not.toContain("#c8372d");
    expect(SOURCE).not.toContain("#ff9a90");
  });

  it("keeps product-owned text wrapping rather than truncating", () => {
    // A Circle name and an owner name are unbounded user content shown at a
    // fixed measure; they wrap. Nothing here may ellipsize.
    expect(SOURCE).not.toContain("truncate");
    expect(SOURCE).not.toContain("text-ellipsis");
    expect(SOURCE).not.toContain("whitespace-nowrap");
    expect(SOURCE).not.toMatch(/line-clamp-\d/);
    expect(SOURCE).toContain("break-words");
    // The code is a single unbroken token at 320px.
    expect(SOURCE).toContain("break-all");
  });

  it("never renders a raw transport error to the reader", () => {
    // `caught.message` reaches the user as "Request failed: 422" or
    // "Invalid Firebase ID token" if it is rendered directly.
    expect(SOURCE).not.toMatch(/setError\(\s*caught/);
    expect(SOURCE).not.toContain("caught.message");
    expect(SOURCE).toContain("That code didn't work. Ask for a new link.");
  });

  it("does not paint a codeless invitation before the redirect fires", () => {
    // Effects run after paint, so the redirect alone is not enough.
    expect(SOURCE).toContain("if (!code) return null;");
  });
});
