import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { DomainNav } from "@/components/dashboard/domain-nav";
import { ROUTES } from "@/lib/navigation/routes";

vi.mock("next/navigation", () => ({
  usePathname: () => ROUTES.KAI_PORTFOLIO,
}));

describe("DomainNav", () => {
  it("covers domain navigation icon accessibility", () => {
    const { container } = render(<DomainNav />);

    expect(screen.getByRole("link", { name: "Kai" })).toBeTruthy();

    const icon = container.querySelector("svg");

    expect(icon).toBeTruthy();
    expect(icon?.getAttribute("aria-hidden")).toBe("true");
  });
});
