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

  it("gives the light canvas a visible four-corner accent wash and grain", () => {
    const css = readFileSync(join(process.cwd(), "app/globals.css"), "utf8");
    const lightBlockMatch = css.match(
      /\.foundation-public-ambient \{[^}]*\}/,
    );
    expect(lightBlockMatch).toBeTruthy();
    const lightBlock = lightBlockMatch![0];

    // Stronger than dark mode's 6-8%, not weaker: mixing the same percentage
    // of accent into near-white reads far fainter than into near-black, so
    // light mode needs more, not less, to actually read as an accent glow.
    expect(lightBlock).toContain("--foundation-grain-opacity: 0.1");
    expect(lightBlock).toContain("--foundation-ambient-primary: 12%");
    expect(lightBlock).toContain("radial-gradient");
    expect(lightBlock).not.toContain("background-image: none");

    expect(css).toContain("--foundation-grain-opacity: 0.08");
    expect(css).toContain("opacity: var(--foundation-grain-opacity, 0.035)");
  });
});
