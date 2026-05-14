import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SettingsRow, SettingsSegmentedTabs } from "@/components/profile/settings-ui";

describe("SettingsRow", () => {
  it("wraps both primary action and trailing in a single interactive row", () => {
    const handleOpen = vi.fn();
    const handleTrailing = vi.fn();
    render(
      <SettingsRow
        title="Open privacy"
        description="Manage vault controls"
        onClick={handleOpen}
        trailing={
          <button type="button" onClick={handleTrailing}>
            Manage
          </button>
        }
      />
    );

    // Clicking the primary area fires the row onClick
    fireEvent.click(screen.getByRole("button", { name: /open privacy/i }));

    // The trailing button is also reachable
    const trailingButton = screen
      .getAllByRole("button")
      .find((element) => element.textContent?.trim() === "Manage");
    expect(trailingButton).toBeTruthy();
    fireEvent.click(trailingButton!);

    // Both handlers fire (trailing click propagation stopped, so only trailing fires)
    expect(handleOpen).toHaveBeenCalledTimes(1);
    expect(handleTrailing).toHaveBeenCalledTimes(1);
  });

  it("keeps a trailing switch accessible within the unified row", () => {
    const handleOpen = vi.fn();
    render(
      <SettingsRow
        title="Enable sync"
        description="Warm secure data on unlock"
        onClick={handleOpen}
        trailing={<input type="checkbox" aria-label="Enable sync switch" />}
      />
    );

    // Row is clickable
    fireEvent.click(screen.getByRole("button", { name: /enable sync/i }));
    expect(handleOpen).toHaveBeenCalledTimes(1);

    // Switch is still accessible
    expect(screen.getByLabelText("Enable sync switch")).toBeTruthy();
  });

  it("renders a non-interactive row without creating a button wrapper", () => {
    render(
      <SettingsRow
        title="Current status"
        description="Nothing to do right now"
      />
    );

    expect(screen.queryByRole("button", { name: /current status/i })).toBeNull();
    expect(screen.getByText("Current status").textContent).toBe("Current status");
  });

  it("supports asChild rows without losing row content", () => {
    render(
      <SettingsRow asChild title="Open profile" description="Go to privacy workspace">
        <a href="/profile" data-testid="profile-link" />
      </SettingsRow>
    );

    const link = screen.getByTestId("profile-link");
    expect(link.tagName).toBe("A");
    expect(link.textContent).toContain("Open profile");
    expect(link.textContent).toContain("Go to privacy workspace");
  });
});

describe("SettingsSegmentedTabs", () => {
  it("keeps the active tab selected and switches tabs through user interaction", () => {
    const handleValueChange = vi.fn();
    render(
      <SettingsSegmentedTabs
        value="my"
        onValueChange={handleValueChange}
        options={[
          { value: "kai", label: "Kai list" },
          { value: "my", label: "My list" },
        ]}
      />
    );

    const active = screen.getByRole("button", { name: "My list" });
    const inactive = screen.getByRole("button", { name: "Kai list" });

    expect(active.getAttribute("data-state")).toBe("active");
    expect(active.getAttribute("aria-pressed")).toBe("true");
    expect(inactive.getAttribute("data-state")).toBe("inactive");
    expect(inactive.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(active);
    expect(handleValueChange).not.toHaveBeenCalled();

    fireEvent.click(inactive);
    expect(handleValueChange).toHaveBeenCalledWith("kai");
  });
});
