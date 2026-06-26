import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AsyncActionStatus } from "@/components/system/async-action-status";

describe("AsyncActionStatus", () => {
  it("renders retrying status copy", () => {
    render(<AsyncActionStatus state="retrying" />);

    const status = screen.getByRole("status");

    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.textContent).toBe("Retrying\u2026");
    expect(status.querySelector("svg")?.getAttribute("aria-hidden")).toBe(
      "true",
    );
  });
});
