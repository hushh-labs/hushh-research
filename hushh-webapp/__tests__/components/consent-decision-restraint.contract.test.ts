import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * A consent decision is one filled button, one quiet one, and nothing else.
 *
 * The two places a person decides whether someone else may see their
 * information are the pending-request card in chat and the decision row in
 * the Consent Center. Both are governed by the Restraint Charter (design.md,
 * visual-language rule 1): a decision surface carries exactly one primary
 * action, no decorative badge, and no second heading restating what the card
 * already says. The deny control is irreversible, so it takes a confirming
 * second tap and must say so to a screen reader.
 *
 * This is a source-level contract, not a render test. The rendered tests for
 * these components cover behaviour; this holds the shape, because the shape
 * is what drifts: a second filled button appears "for clarity", a status
 * badge is added beside the title, a "Your decision" heading goes over the
 * buttons. Each is reasonable alone and together they turn a decision back
 * into a form. The gate reads the source so the drift fails before a
 * screenshot is needed to see it.
 */

const WEB_ROOT = path.resolve(__dirname, "../..");

const CARD = "components/agent/specialist-directive-card.tsx";
const CENTER = "components/consent/consent-center-page.tsx";

/** The morphy Button's default when no variant is passed. */
const PRIMARY_VARIANTS = new Set(["blue-gradient", "default"]);

/**
 * Every opening `<tagName ...>` in `src`, brace- and quote-aware so a `>`
 * inside a prop expression (an arrow, a comparison, a nested element) does
 * not end the tag early. Copied from the restraint-charter verifier
 * (scripts/design/verify-restraint-charter.mjs) so both gates count the same
 * way.
 */
function openingTags(src: string, tagName: string): string[] {
  const tags: string[] = [];
  const needle = `<${tagName}`;
  let i = 0;
  while ((i = src.indexOf(needle, i)) !== -1) {
    const boundary = src[i + needle.length];
    // `<Buttonish` must not match `<Button`; the next char has to end the name.
    if (boundary && !/[\s/>]/.test(boundary)) {
      i += needle.length;
      continue;
    }
    let depth = 0;
    let quote: string | null = null;
    let j = i + needle.length;
    for (; j < src.length; j++) {
      const c = src[j]!;
      if (quote) {
        if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") quote = c;
      else if (c === "{") depth += 1;
      else if (c === "}") depth -= 1;
      else if (c === ">" && depth === 0) break;
    }
    tags.push(src.slice(i, j + 1));
    i = j + 1;
  }
  return tags;
}

/**
 * A button reads as primary when it names no variant (the default is the
 * filled gradient) or spells that default out. The Consent Center writes
 * `variant="blue-gradient"` on its Allow button; that is the same button as a
 * bare `<Button`, and counting it differently would let a second filled
 * button in as long as it named itself.
 */
function isPrimaryButton(tag: string): boolean {
  const variant = tag.match(/\bvariant\s*=\s*(?:"([^"]*)"|\{\s*"([^"]*)"\s*\})/);
  if (!variant) return !/\bvariant\s*=/.test(tag);
  const value = variant[1] ?? variant[2] ?? "";
  return PRIMARY_VARIANTS.has(value);
}

/**
 * Source with comments removed. The brace walks below are quote-aware, and an
 * apostrophe in a comment ("the feed's actionable row") would open a quote
 * that never closes and swallow the rest of the file.
 */
function read(relative: string): string {
  return readFileSync(path.join(WEB_ROOT, relative), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ");
}

/** Source between two anchors that each occur exactly once, in order. */
function between(src: string, label: string, from: string, to: string): string {
  const count = (needle: string) => src.split(needle).length - 1;
  expect(count(from), `${label}: start anchor must occur exactly once: ${from}`).toBe(1);
  expect(count(to), `${label}: end anchor must occur exactly once: ${to}`).toBe(1);
  const start = src.indexOf(from);
  const end = src.indexOf(to, start + from.length);
  expect(end, `${label}: end anchor must follow the start anchor`).toBeGreaterThan(start);
  return src.slice(start, end + to.length);
}

/**
 * The body of a top-level `export function Name(` declaration: from its
 * signature to the matching close brace of the function, quote-aware.
 */
function functionBody(src: string, name: string): string {
  const needle = `export function ${name}(`;
  expect(src.split(needle).length - 1, `${name} must be declared exactly once`).toBe(1);
  const start = src.indexOf(needle);
  const open = src.indexOf("{", src.indexOf(")", start));
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < src.length; i++) {
    const c = src[i]!;
    if (quote) {
      if (c === "\\") i += 1;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`${name}: unbalanced function body`);
}

/** Text nodes and string literals that would render as a heading. */
function hasHeading(src: string, text: string): boolean {
  return new RegExp(`(?:>\\s*|["'\`])${text}(?:\\s*<|["'\`])`).test(src);
}

type DecisionSurface = {
  label: string;
  source: () => string;
  /** The deny control, found by its stable attribute. */
  denyControl: string;
};

const SURFACES: DecisionSurface[] = [
  {
    label: "chat pending-request card",
    source: () => functionBody(read(CARD), "SpecialistPendingConsentRequestCard"),
    denyControl: 'data-testid="specialist-pending-consent-deny"',
  },
  {
    label: "Consent Center decision row",
    source: () => {
      const src = read(CENTER);
      const approveAnchor = 'data-voice-control-id="consent_approve"';
      const revokeAnchor = 'data-voice-control-id="consent_revoke"';
      between(src, "Consent Center decision row", approveAnchor, revokeAnchor);
      // Both anchors are the LAST attribute of their button, so each sits
      // inside an opening tag. The region runs from the Allow button's
      // `<Button` to the `>` that closes the Stop sharing button's tag; cut
      // at the anchor itself and the unterminated tag swallows whatever
      // follows, which is how an appended second button once went uncounted.
      const allowButton = src.lastIndexOf("<Button", src.indexOf(approveAnchor));
      const revokeButton = src.lastIndexOf("<Button", src.indexOf(revokeAnchor));
      const revokeTag = openingTags(src.slice(revokeButton), "Button")[0];
      expect(allowButton).toBeGreaterThan(-1);
      expect(revokeTag).toBeDefined();
      return src.slice(allowButton, revokeButton + revokeTag!.length);
    },
    denyControl: 'data-voice-control-id="consent_deny"',
  },
];

describe("consent decision restraint", () => {
  for (const surface of SURFACES) {
    describe(surface.label, () => {
      it("carries exactly one primary button", () => {
        const buttons = openingTags(surface.source(), "Button");
        const primary = buttons.filter(isPrimaryButton);
        expect(
          primary,
          `${surface.label}: one decision, one filled button. Found ${primary.length}.`,
        ).toHaveLength(1);
        // And the gate has something to count: a region that lost its
        // buttons would otherwise fail above, but say so plainly here too.
        expect(buttons.length).toBeGreaterThanOrEqual(2);
      });

      it("carries no badge", () => {
        expect(
          openingTags(surface.source(), "Badge"),
          `${surface.label}: a badge on a decision surface is decoration. Restraint Charter, law 5.`,
        ).toEqual([]);
      });

      it("does not restate the decision as a heading", () => {
        const src = surface.source();
        for (const heading of ["Your decision", "Request details"]) {
          expect(
            hasHeading(src, heading),
            `${surface.label}: "${heading}" repeats what the card already says.`,
          ).toBe(false);
        }
      });

      it("arms the deny control and says so to assistive technology", () => {
        const src = surface.source();
        const deny = openingTags(src, "Button").find((tag) =>
          tag.includes(surface.denyControl),
        );
        expect(deny, `${surface.label}: deny control not found`).toBeDefined();
        // The armed state's accessible name comes from the shared hook, so
        // "Confirm Deny" / "Deny (tap again to confirm)" read the same on both
        // surfaces and change in one place.
        expect(deny).toMatch(/aria-label=\{[^}]*\.ariaLabel\(/);
        expect(deny).toMatch(/\.activate\(/);
      });
    });
  }
});
