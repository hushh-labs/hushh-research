import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AccessibilityStatusAnnouncer } from "@/components/system/accessibility-status-announcer";

describe("AccessibilityStatusAnnouncer", () => {
  it("renders a polite live region by default", () => {
    render(<AccessibilityStatusAnnouncer message="Filters updated" />);

    const status = screen.getByRole("status");

    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.getAttribute("aria-atomic")).toBe("true");
    expect(status.className).toContain("sr-only");
    expect(status.textContent).toBe("Filters updated");
  });
  
  it("renders nothing when message is empty", () => {
    const { container } = render(
      <AccessibilityStatusAnnouncer message="" />,
    );

    expect(container.innerHTML).toBe("");
  });

  it("renders an assertive live region when assertive is true", () => {
    render(
      <AccessibilityStatusAnnouncer
        message="Critical alert"
        assertive
      />,
    );

    const status = screen.getByRole("status");

    expect(status.getAttribute("aria-live")).toBe("assertive");
    expect(status.textContent).toBe("Critical alert");
  });
});
