import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { FoundationPublicAmbient } from "@/components/app-ui/foundation-public-ambient";

describe("FoundationPublicAmbient", () => {
  it("keeps the pre-sign-in Foundation canvas behind every route", () => {
    render(<FoundationPublicAmbient />);

    expect(screen.getByTestId("foundation-canvas")).toHaveAttribute(
      "data-foundation-canvas",
      "true",
    );
    expect(screen.getByTestId("foundation-canvas")).toHaveClass("foundation-public-ambient");
  });
});
