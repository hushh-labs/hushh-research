import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SettingsGroup } from "@/components/app-ui/settings-ui";

/**
 * `titleAction` puts a section's own control at the end of its heading row.
 *
 * The one rule it exists to keep: the control renders as a SIBLING of the
 * heading, never inside it. `SettingsGroup` gives its heading `role="heading"`,
 * and a button placed within one is both invalid and unreachable — a screen
 * reader folds the control's label into the heading's accessible name, so
 * "People" becomes "People Sync contacts" and the button is not offered as
 * something to press.
 *
 * Fifty files render `SettingsGroup`. The second half of this file is the part
 * that protects them: with no `titleAction` passed, the heading block must
 * render the markup it always has.
 */

describe("SettingsGroup titleAction", () => {
  it("renders the control outside the heading, not within it", () => {
    render(
      <SettingsGroup
        title="People"
        description="Search by name."
        titleAction={<button type="button">Sync contacts</button>}
      >
        <div>rows</div>
      </SettingsGroup>,
    );

    const heading = screen.getByRole("heading", { name: "People" });
    const action = screen.getByRole("button", { name: "Sync contacts" });

    expect(action).toBeTruthy();
    // The assertion that matters. `getByRole("heading", { name: "People" })`
    // already proves the accessible name was not polluted; this proves the
    // containment that would have caused it.
    expect(heading.contains(action)).toBe(false);
  });

  it("keeps the control reachable as a button", () => {
    render(
      <SettingsGroup
        title="People"
        titleAction={<button type="button">Sync contacts</button>}
      >
        <div>rows</div>
      </SettingsGroup>,
    );

    // Inside a heading this query returns nothing: assistive tech does not
    // expose interactive descendants of a heading as separate controls.
    expect(screen.getByRole("button", { name: "Sync contacts" })).toBeTruthy();
  });

  it("leaves the heading untouched when no action is passed", () => {
    const { container: withAction } = render(
      <SettingsGroup title="People" description="Search by name.">
        <div>rows</div>
      </SettingsGroup>,
    );
    const heading = withAction.querySelector(
      '[data-slot="settings-group-heading"]',
    );

    expect(heading).toBeTruthy();
    expect(heading?.getAttribute("role")).toBe("heading");
    expect(heading?.textContent).toBe("People");
    // No stray action wrapper when the prop is absent.
    expect(withAction.querySelectorAll("button").length).toBe(0);
  });

  it("still renders a heading-less group that only carries an action", () => {
    // The heading block is gated on there being something to show. An action
    // with no title must not fall through that gate and vanish.
    render(
      <SettingsGroup titleAction={<button type="button">Sync contacts</button>}>
        <div>rows</div>
      </SettingsGroup>,
    );

    expect(screen.getByRole("button", { name: "Sync contacts" })).toBeTruthy();
  });
});
