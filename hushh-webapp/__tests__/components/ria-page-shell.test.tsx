import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { RiaCompatibilityState } from "@/components/ria/ria-page-shell";

describe("RiaCompatibilityState", () => {
  it("covers compatibility warning copy", () => {
    render(
      <RiaCompatibilityState
        title="Client workspace is unavailable"
        description="IAM schema is still warming up."
      />,
    );

    expect(screen.getByText("Compatibility Mode")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Client workspace is unavailable" })).toBeTruthy();
    expect(screen.getByText("IAM schema is still warming up.")).toBeTruthy();
    expect(
      screen.getByText(
        /This surface is running in degraded compatibility mode until the full IAM contract is available in the active environment\./,
      ),
    ).toBeTruthy();
  });
});
