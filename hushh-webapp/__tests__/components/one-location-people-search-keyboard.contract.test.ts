import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { afterEach, describe, expect, it, vi } from "vitest";
import { SheetSearch } from "@/components/app-ui/sheet-parts";
import { PersonSearchInput } from "@/components/one-location/redesign/selectors";

/**
 * The Location people-search surfaces on a real iPhone.
 *
 * Real keyboard/safe-area geometry is covered by circle-invite-picker.layout.
 * These architecture guards keep both callers on that shared sizing seam;
 * DOM cases exercise the keyboard attributes and handlers on both controls.
 */

const read = (relativePath: string) =>
  readFileSync(join(process.cwd(), relativePath), "utf8");

const NAMED_CIRCLE_SHEET =
  "components/one-location/redesign/circles/named-circle-flows.tsx";
const CIRCLE_GROW_SHEET =
  "components/one-location/redesign/circles/circle-grow-actions.tsx";
const PICKER_SHEETS = [NAMED_CIRCLE_SHEET, CIRCLE_GROW_SHEET];

describe("Location people-search keyboard contract", () => {
  it.each(PICKER_SHEETS)("uses the browser-verified shared keyboard sizing (%s)", (path) => {
    const source = read(path);
    expect(source).toContain("<AdaptiveSheetContent");
    expect(source).toContain("taskSurfaceStyles.people");
    expect(source).not.toContain("max-h-[88dvh]");
    expect(read("lib/morphy-ux/ui/task-surfaces.module.css")).toContain(
      "height: calc(85dvh - var(--kb-height, 0px))",
    );
  });

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

afterEach(() => { cleanup(); vi.clearAllTimers(); vi.useRealTimers(); });

describe.each([
  ["PersonSearchInput", () => createElement(PersonSearchInput, { value: "", onChange: vi.fn() })],
  ["SheetSearch", () => createElement(SheetSearch, { value: "", onValueChange: vi.fn() })],
] as const)("%s on a phone keyboard", (_name, control) => {

  it("stops iOS rewriting the name as it is typed", () => {
    // A surname is not a dictionary word. Autocorrect substitutes one mid-search
    // and the list jumps to the wrong people, or empties, while the person
    // watches their own typing change under them.
    render(control());
    const input = screen.getByRole("searchbox");
    expect(input).toHaveAttribute("autocorrect", "off");
    expect(input).toHaveAttribute("autocapitalize", "none");
    expect(input).toHaveAttribute("spellcheck", "false");
  });

  it("gives the return key a job, and closes the keyboard with it", () => {
    // Without this the key reads "return", does nothing at all, and the
    // keyboard stays parked over the results the person is trying to read.
    vi.useFakeTimers();
    render(control());
    const input = screen.getByRole("searchbox");
    input.focus();
    expect(input).toHaveAttribute("enterkeyhint", "search");
    const result = fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
    expect(result).toBe(false);
    expect(input).not.toHaveFocus();
  });

  it("scrolls itself out from behind the keyboard when tapped", () => {
    // On a small iPhone the field otherwise sits behind the keyboard and the
    // person types blind. The delay is what lets the keyboard finish animating,
    // so the measurement is taken against the shrunken viewport.
    vi.useFakeTimers();
    render(control());
    const input = screen.getByRole("searchbox");
    const scrollIntoView = vi.fn();
    input.scrollIntoView = scrollIntoView;
    input.focus();
    expect(scrollIntoView).not.toHaveBeenCalled();
    vi.advanceTimersByTime(250);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "center", behavior: "smooth" });
  });
});
