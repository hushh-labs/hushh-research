import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The Location people-search surfaces on a real iPhone.
 *
 * These are all keyboard-and-webview behaviours, so jsdom cannot observe them:
 * `--kb-height` is set by the native keyboard inset manager, and autocorrect
 * and `enterKeyHint` are keyboard features with no DOM effect to assert. What
 * IS assertable, and what actually regressed, is whether the source still says
 * the thing that makes the phone behave — so these pin the source.
 */

const read = (relativePath: string) =>
  readFileSync(join(process.cwd(), relativePath), "utf8");

const PICKER_SHEETS = [
  "components/one-location/redesign/circles/named-circle-flows.tsx",
  "components/one-location/redesign/circles/circle-grow-actions.tsx",
];

describe("Location people-search keyboard contract", () => {
  it.each(PICKER_SHEETS)(
    "keeps the keyboard height inside the sheet's max-height (%s)",
    (path) => {
      const source = read(path);

      // SheetContent pairs `bottom-[var(--kb-height,0px)]` with a max-height
      // that subtracts the same value: the sheet lifts above the keyboard and
      // shrinks by exactly as much. A bare `max-h-[88dvh]` wins the
      // tailwind-merge and drops only the shrink, so the sheet still lifts and
      // carries its own title and search field off the top of the screen.
      expect(source).toContain("max-h-[calc(88dvh-var(--kb-height,0px))]");
      expect(source).not.toContain("max-h-[88dvh]");
    },
  );

  it.each(PICKER_SHEETS)(
    "does not let a downward swipe over the results close the sheet (%s)",
    (path) => {
      // Swiping down through a list is how a phone scrolls it back up. With
      // drag-dismiss on, that gesture drags the sheet away instead and can
      // close it, losing the query and every person already ticked.
      expect(read(path)).toContain("dragDismiss={false}");
    },
  );
});

describe("PersonSearchInput on a phone keyboard", () => {
  const source = read("components/one-location/redesign/selectors.tsx");

  it("stops iOS rewriting the name as it is typed", () => {
    // A surname is not a dictionary word. Autocorrect substitutes one mid-search
    // and the list jumps to the wrong people, or empties, while the person
    // watches their own typing change under them.
    expect(source).toContain('autoCorrect="off"');
    expect(source).toContain('autoCapitalize="none"');
    expect(source).toContain("spellCheck={false}");
  });

  it("gives the return key a job, and closes the keyboard with it", () => {
    // Without this the key reads "return", does nothing at all, and the
    // keyboard stays parked over the results the person is trying to read.
    expect(source).toContain('enterKeyHint="search"');
    expect(source).toContain("event.currentTarget.blur()");
  });

  it("scrolls itself out from behind the keyboard when tapped", () => {
    // On a small iPhone the field otherwise sits behind the keyboard and the
    // person types blind. The delay is what lets the keyboard finish animating,
    // so the measurement is taken against the shrunken viewport.
    expect(source).toContain("scrollIntoView(");
    expect(source).toContain('block: "center"');
  });
});
