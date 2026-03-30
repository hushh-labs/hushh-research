import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SettingsRow } from "@/components/profile/settings-ui";

describe("SettingsRow", () => {
  it("keeps the primary action separate from a trailing button", () => {
    const handleOpen = vi.fn();
    const handleTrailing = vi.fn();
    const { container } = render(
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

    expect(container.querySelector("button button")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /open privacy/i }));
    const trailingButton = screen
      .getAllByRole("button")
      .find((element) => element.textContent?.trim() === "Manage");
    expect(trailingButton).toBeTruthy();
    fireEvent.click(trailingButton!);

    expect(handleOpen).toHaveBeenCalledTimes(1);
    expect(handleTrailing).toHaveBeenCalledTimes(1);
  });

  it("keeps a trailing switch control outside the primary action zone", () => {
    const handleOpen = vi.fn();
    const { container } = render(
      <SettingsRow
        title="Enable sync"
        description="Warm secure data on unlock"
        onClick={handleOpen}
        trailing={<input type="checkbox" aria-label="Enable sync switch" />}
      />
    );

    expect(container.querySelector("button input")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /enable sync/i }));
    expect(handleOpen).toHaveBeenCalledTimes(1);
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
