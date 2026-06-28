import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { BreadcrumbLink } from "@/components/ui/breadcrumb";

describe("BreadcrumbLink", () => {
  it("renders as an anchor element", () => {
    render(
      <BreadcrumbLink href="/profile">
        Profile
      </BreadcrumbLink>,
    );

    const link = screen.getByRole("link", {
      name: "Profile",
    });

    expect(link.tagName).toBe("A");
  });
});