import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { TrustedPersonCard } from "@/components/one-location/redesign/cards";
import { buttonVariants } from "@/components/ui/button";

describe("Button compact typography", () => {
  it("keeps the full-size label role off compact action sizes", () => {
    for (const size of ["xs", "sm"] as const) {
      expect(buttonVariants({ size })).not.toContain("ui-text-button-label");
      expect(buttonVariants({ size })).not.toContain("min-h-[50px]");
    }
  });

  it("keeps the Location trusted-person action compact", () => {
    render(
      <TrustedPersonCard
        name="Smirthi"
        actionLabel="Share"
        onAction={() => {}}
      />,
    );

    const shareButton = screen.getByRole("button", { name: "Share" });
    expect(shareButton.className).toContain("min-h-9");
    expect(shareButton.className).toContain("text-sm");
    expect(shareButton.className).not.toContain("ui-text-button-label");
    expect(shareButton.className).not.toContain("min-h-[50px]");
  });

  it("retains the full-size label role for standard call-to-action sizes", () => {
    expect(buttonVariants({ size: "default" })).toContain(
      "ui-text-button-label",
    );
    expect(buttonVariants({ size: "default" })).toContain("min-h-[50px]");
    expect(buttonVariants({ size: "lg" })).toContain("ui-text-button-label");
    expect(buttonVariants({ size: "lg" })).toContain("min-h-[50px]");
  });
});
