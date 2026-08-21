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

  it("uses the shared grouped canvas without a decorative wash or grain", () => {
    const css = readFileSync(join(process.cwd(), "app/globals.css"), "utf8");
    const lightBlockMatch = css.match(
      /^\.foundation-public-ambient \{[^}]*\}/m,
    );
    expect(lightBlockMatch).toBeTruthy();
    const lightBlock = lightBlockMatch![0];

    expect(lightBlock).toContain("--foundation-grain-opacity: 0");
    expect(lightBlock).toContain(
      "background-color: var(--app-grouped-background)",
    );
    expect(lightBlock).toContain("background-image: none");
    expect(lightBlock).not.toContain("radial-gradient");

    const darkBlock = css.match(
      /^\.dark \.foundation-public-ambient \{[^}]*\}/m,
    )?.[0];
    expect(darkBlock).toContain("--foundation-grain-opacity: 0");
    expect(darkBlock).toContain("background-image: none");
    expect(css).toMatch(/\.one-grain \{\s*display: none !important;/m);
  });
});
