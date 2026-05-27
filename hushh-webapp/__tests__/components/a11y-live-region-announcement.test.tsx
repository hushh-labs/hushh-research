import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

function StatusAnnouncement({ message }: { message: string }) {
  return (
    <div role="status" aria-live="polite">
      {message}
    </div>
  );
}

describe("a11y live region announcement", () => {
  it("preserves polite status announcements for async updates", () => {
    render(<StatusAnnouncement message="Portfolio sync completed" />);

    const status = screen.getByRole("status");

    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.textContent).toBe("Portfolio sync completed");
  });
});