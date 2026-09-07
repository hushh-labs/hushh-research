import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SettingsGroup } from "@/components/app-ui/settings-ui";

/** Title actions stay separate from the heading. Optional actions preserve the
 * existing heading and remain available when the group has no title. */

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
