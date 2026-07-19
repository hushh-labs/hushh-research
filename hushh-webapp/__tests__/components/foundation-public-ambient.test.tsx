import { readFileSync } from "node:fs";
import { join } from "node:path";

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

  it("keeps the light canvas neutral white with a visible technical grid", () => {
    const css = readFileSync(join(process.cwd(), "app/globals.css"), "utf8");

    expect(css).toContain("--foundation-grain-opacity: 0.07");
    expect(css).toContain("--foundation-grain-opacity: 0.08");
    expect(css).toContain("background-image: none;");
    expect(css).toContain("opacity: var(--foundation-grain-opacity, 0.035)");
  });
});
