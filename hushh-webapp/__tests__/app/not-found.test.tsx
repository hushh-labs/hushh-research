import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import AppNotFoundPage from "@/app/not-found";
import * as BrowserNavigation from "@/lib/utils/browser-navigation";

vi.mock("@/lib/utils/browser-navigation", () => ({
  requestInternalAppNavigation: vi.fn(),
}));

describe("AppNotFoundPage", () => {
  it("renders a visible recovery state instead of redirecting silently", () => {
    render(<AppNotFoundPage />);

    expect(screen.getByText("Page not found")).toBeTruthy();
    expect(
      screen.getByText("The content you're looking for is unavailable or has been moved."),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: /back/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /home/i })).toBeTruthy();
  });

  it("routes home through canonical internal navigation", () => {
    render(<AppNotFoundPage />);

    fireEvent.click(screen.getByRole("button", { name: /home/i }));

    expect(BrowserNavigation.requestInternalAppNavigation).toHaveBeenCalledWith({
      href: "/",
      replace: true,
      scroll: false,
    });
  });

  it("keeps browser back recovery available", () => {
    const backSpy = vi.spyOn(window.history, "back").mockImplementation(() => {});
    render(<AppNotFoundPage />);

    fireEvent.click(screen.getByRole("button", { name: /back/i }));

    expect(backSpy).toHaveBeenCalled();
    backSpy.mockRestore();
  });
});
