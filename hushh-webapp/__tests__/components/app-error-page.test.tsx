import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import AppErrorPage from "@/app/error";

vi.mock("@/lib/utils/browser-navigation", () => ({
  requestInternalAppNavigation: vi.fn(),
}));

function makeError(digest?: string) {
  const error = new Error("boom") as Error & { digest?: string };
  if (digest) error.digest = digest;
  return error;
}

describe("app/error.tsx route error boundary", () => {
  it("renders a calm, non-blaming recovery moment instead of a raw error", () => {
    render(<AppErrorPage error={makeError()} reset={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "Something went wrong" })).toBeTruthy();
    expect(
      screen.getByText("That one's on us, not you. Try again, or head back to One."),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: /try again/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /go home/i })).toBeTruthy();
  });

  it("never leaks the raw error message or a stack to the person", () => {
    const { container } = render(
      <AppErrorPage error={makeError()} reset={vi.fn()} />,
    );

    // The thrown message must not be rendered; users get human copy only.
    expect(container.textContent).not.toContain("boom");
  });

  it("retries in place via reset rather than reloading the app", () => {
    const reset = vi.fn();
    render(<AppErrorPage error={makeError()} reset={reset} />);

    fireEvent.click(screen.getByRole("button", { name: /try again/i }));

    expect(reset).toHaveBeenCalledTimes(1);
  });

  it("shows the support reference only when a digest exists", () => {
    const { rerender, container } = render(
      <AppErrorPage error={makeError()} reset={vi.fn()} />,
    );
    expect(container.textContent).not.toContain("Reference:");

    rerender(<AppErrorPage error={makeError("abc123")} reset={vi.fn()} />);
    expect(screen.getByText("Reference: abc123")).toBeTruthy();
  });
});
