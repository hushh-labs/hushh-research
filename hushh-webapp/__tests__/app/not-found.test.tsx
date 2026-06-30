import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";

import AppNotFoundPage from "@/app/not-found";
import * as BrowserNavigation from "@/lib/utils/browser-navigation";

vi.mock("@/lib/utils/browser-navigation", () => ({
  requestInternalAppNavigation: vi.fn(),
}));

describe("AppNotFoundPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should render expected content and navigation actions", () => {
    render(<AppNotFoundPage />);

    expect(screen.getByRole("heading", { name: /page not found/i })).toBeTruthy();
    expect(screen.getByText(/page you're looking for doesn't exist/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /go back/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /go home/i })).toBeTruthy();
  });

  it("should trigger canonical internal navigation when home is clicked", () => {
    render(<AppNotFoundPage />);

    fireEvent.click(screen.getByRole("button", { name: /go home/i }));

    expect(BrowserNavigation.requestInternalAppNavigation).toHaveBeenCalledWith({
      href: "/",
      replace: true,
      scroll: false,
    });
  });

  it("should attempt browser back recovery", () => {
    const backSpy = vi.spyOn(window.history, "back").mockImplementation(() => { });

    render(<AppNotFoundPage />);
    fireEvent.click(screen.getByRole("button", { name: /go back/i }));

    expect(backSpy).toHaveBeenCalled();
    backSpy.mockRestore();
  });
});
