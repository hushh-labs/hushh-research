import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ApiRetryState } from "@/components/system/api-retry-state";

describe("ApiRetryState", () => {
  it("renders retry action with type='button'", () => {
    render(<ApiRetryState onRetry={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Retry" }).getAttribute("type")).toBe(
      "button",
    );
  });
});
